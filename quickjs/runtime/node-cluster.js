/*
 * node:cluster on the native host, over fork() and its IPC channel (node-child.js).
 *
 * Node hands the listening socket to the workers as a descriptor. The host cannot pass descriptors (and Windows
 * before 10 has no AF_UNIX to carry them), so the primary owns the listening socket instead: a worker that calls
 * server.listen(port) binds a private server on 127.0.0.1 with an ephemeral port, tells the primary, and the primary
 * accepts on the real address and proxies each connection to the next worker in round-robin order. Every worker
 * sees the address the program asked for. Since the proxy hop would otherwise make every connection look like it
 * came from the primary's loopback peer, the primary also sends the real remote address/port/family for each
 * connection to the target worker over the existing IPC channel (one "connection" message per proxied connection,
 * in the same order the primary opens the upstream sockets). The worker matches each message to the next accepted
 * socket on that server, in arrival order, and reports the real values as `socket.remoteAddress`/`remotePort`/
 * `remoteFamily`. This is in-order correlation, not a stream-level protocol, so it never touches the proxied bytes
 * themselves and cannot corrupt HTTP/TLS traffic; it only has to win the race against the client's own first byte
 * reaching the worker, which requires a second network hop it doesn't need.
 */

const SCHED_NONE = 1;
const SCHED_RR = 2;
const CMD = "NODE_CLUSTER";

function codedError(Ctor, code, message) {
	const error = new Ctor(message);
	error.code = code;
	return error;
}

export function createCluster({ EventEmitter, childProcess, net, tls, process }) {
	const cluster = new EventEmitter();
	const isWorker = Object.prototype.hasOwnProperty.call(process.env, "NODE_UNIQUE_ID");
	const uniqueId = process.env.NODE_UNIQUE_ID;
	// Node keeps it out of the worker's environment once read.
	if (isWorker) delete process.env.NODE_UNIQUE_ID;
	const noHandles = () => {
		throw codedError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Sending handles between cluster workers is not supported by this host");
	};

	class Worker extends EventEmitter {
		constructor(options = {}) {
			super();
			this.exitedAfterDisconnect = undefined;
			this.state = options.state || "none";
			this.id = options.id | 0;
			this.process = options.process;
		}

		send(message, handle, options, callback) {
			if (handle !== undefined && handle !== null && typeof handle !== "function") noHandles();
			return this.process.send(message, handle, options, callback);
		}

		isConnected() {
			return Boolean(this.process && this.process.connected);
		}

		isDead() {
			return this.process.exitCode != null || this.process.signalCode != null;
		}
	}
	cluster.Worker = Worker;
	cluster.SCHED_NONE = SCHED_NONE;
	cluster.SCHED_RR = SCHED_RR;
	const policyEnv = process.env.NODE_CLUSTER_SCHED_POLICY;
	cluster.schedulingPolicy =
		policyEnv === "rr" ? SCHED_RR : policyEnv === "none" ? SCHED_NONE : process.platform === "win32" ? SCHED_NONE : SCHED_RR;
	cluster.settings = {};

	const send = (target, message, callback) => target.send({ cmd: CMD, ...message }, undefined, undefined, callback);

	if (isWorker) setupWorkerSide();
	else setupPrimarySide();
	return cluster;

	// ---- the primary ------------------------------------------------------------------------------------------------
	function setupPrimarySide() {
		cluster.isWorker = false;
		cluster.isMaster = true;
		cluster.isPrimary = true;
		cluster.workers = {};
		const handles = new Map();
		let ids = 0;

		Worker.prototype.disconnect = function disconnect() {
			this.exitedAfterDisconnect = true;
			if (this.isConnected()) send(this.process, { act: "disconnect" });
			removeHandlesForWorker(this);
			removeWorker(this);
			return this;
		};
		Worker.prototype.kill = Worker.prototype.destroy = function kill(signal) {
			const proc = this.process;
			signal = signal || "SIGTERM";
			if (this.isConnected()) {
				this.once("disconnect", () => proc.kill(signal));
				this.disconnect();
				return;
			}
			proc.kill(signal);
		};

		function removeWorker(worker) {
			delete cluster.workers[worker.id];
		}

		function dropEntry(entry) {
			handles.delete(entry.key);
			entry.server?.close();
		}

		function removeHandlesForWorker(worker) {
			for (const entry of [...handles.values()]) {
				entry.workers = entry.workers.filter((item) => item.worker !== worker);
				if (entry.workers.length === 0) dropEntry(entry);
			}
		}

		cluster.setupPrimary = cluster.setupMaster = function setupPrimary(options) {
			const settings = {
				args: process.argv.slice(2),
				exec: process.argv[1],
				execArgv: process.execArgv,
				silent: false,
				...cluster.settings,
				...options,
			};
			cluster.settings = settings;
			process.nextTick(() => cluster.emit("setup", { ...settings }));
		};

		cluster.fork = function fork(env) {
			cluster.setupPrimary();
			const settings = cluster.settings;
			const id = ++ids;
			const workerEnv = { ...process.env, ...env, NODE_UNIQUE_ID: `${id}` };
			const child = childProcess.fork(settings.exec, settings.args, {
				cwd: settings.cwd,
				env: workerEnv,
				serialization: settings.serialization,
				silent: settings.silent,
				stdio: settings.stdio,
				execArgv: settings.execArgv,
				gid: settings.gid,
				uid: settings.uid,
			});
			const worker = new Worker({ id, process: child, state: "none" });
			child.on("error", (error) => worker.emit("error", error));
			child.on("message", (message, handle) => {
				worker.emit("message", message, handle);
				cluster.emit("message", worker, message, handle);
			});
			child.on("internalMessage", (message) => onInternal(worker, message));
			child.once("exit", (exitCode, signalCode) => {
				if (!worker.isConnected()) {
					removeHandlesForWorker(worker);
					removeWorker(worker);
				}
				worker.exitedAfterDisconnect = Boolean(worker.exitedAfterDisconnect);
				worker.state = "dead";
				worker.emit("exit", exitCode, signalCode);
				cluster.emit("exit", worker, exitCode, signalCode);
			});
			child.once("disconnect", () => {
				removeHandlesForWorker(worker);
				if (worker.isDead()) removeWorker(worker);
				worker.exitedAfterDisconnect = Boolean(worker.exitedAfterDisconnect);
				worker.state = "disconnected";
				worker.emit("disconnect");
				cluster.emit("disconnect", worker);
			});
			cluster.workers[worker.id] = worker;
			process.nextTick(() => cluster.emit("fork", worker));
			return worker;
		};

		cluster.disconnect = function disconnect(callback) {
			const list = Object.values(cluster.workers).filter((worker) => worker.isConnected());
			let waiting = list.length;
			const done = () => {
				if (typeof callback === "function") callback();
			};
			if (waiting === 0) {
				process.nextTick(done);
				return;
			}
			for (const worker of list) {
				worker.once("disconnect", () => {
					if (--waiting === 0) done();
				});
				worker.disconnect();
			}
		};

		function onInternal(worker, message) {
			if (!message || message.cmd !== CMD) return;
			switch (message.act) {
				case "online":
					worker.state = "online";
					worker.emit("online");
					cluster.emit("online", worker);
					break;
				case "queryServer":
					queryServer(worker, message);
					break;
				case "listening": {
					const address = { address: message.address, port: message.port, addressType: message.addressType };
					worker.state = "listening";
					worker.emit("listening", address);
					cluster.emit("listening", worker, address);
					break;
				}
				case "closeServer": {
					const entry = handles.get(message.key);
					if (!entry) break;
					entry.workers = entry.workers.filter((item) => !(item.worker === worker && item.port === message.internalPort));
					if (entry.workers.length === 0) dropEntry(entry);
					break;
				}
				case "exitedAfterDisconnect":
					worker.exitedAfterDisconnect = true;
					break;
			}
		}

		function queryServer(worker, message) {
			const { key } = message;
			let entry = handles.get(key);
			if (!entry) {
				entry = { key, workers: [], next: 0, server: null, info: null, waiters: [] };
				handles.set(key, entry);
				const current = entry;
				const server = net.createServer((client) => route(current, client));
				entry.server = server;
				const fail = (error) => {
					if (handles.get(key) === current) handles.delete(key);
					for (const waiter of current.waiters.splice(0)) waiter(error, null);
				};
				server.once("error", fail);
				const options = { port: message.port, backlog: message.backlog };
				if (message.address) options.host = message.address;
				server.listen(options, () => {
					server.removeListener("error", fail);
					server.on("error", () => {});
					current.info = server.address();
					for (const waiter of current.waiters.splice(0)) waiter(null, current.info);
				});
			}
			entry.workers.push({ worker, port: message.internalPort });
			const reply = (error, address) => {
				if (!worker.isConnected()) return;
				if (error) {
					send(worker.process, { act: "queryServerReply", seq: message.seq, error: { code: error.code, message: error.message } });
				} else send(worker.process, { act: "queryServerReply", seq: message.seq, address });
			};
			if (entry.info) reply(null, entry.info);
			else entry.waiters.push(reply);
		}

		function route(entry, client) {
			const target = entry.workers[entry.next++ % entry.workers.length];
			if (!target) {
				client.destroy();
				return;
			}
			const upstream = net.connect({ host: "127.0.0.1", port: target.port });
			// Tell the target worker who the real peer is, over IPC rather than in-band: sent right away, well
			// ahead of the client's own bytes, which still have to make the client -> primary -> worker round trip.
			if (target.worker.isConnected()) {
				send(target.worker.process, {
					act: "connection",
					internalPort: target.port,
					address: client.remoteAddress,
					port: client.remotePort,
					family: client.remoteFamily,
				});
			}
			client.pipe(upstream);
			upstream.pipe(client);
			const drop = () => {
				client.destroy();
				upstream.destroy();
			};
			client.on("error", drop);
			upstream.on("error", drop);
		}
	}

	// ---- a worker -----------------------------------------------------------------------------------------------------
	function setupWorkerSide() {
		cluster.isWorker = true;
		cluster.isMaster = false;
		cluster.isPrimary = false;
		const worker = new Worker({ id: Number(uniqueId), process, state: "online" });
		cluster.worker = worker;
		// The program's own message listeners on the worker are attached to the process only once it asks, so the
		// channel does not keep an otherwise idle worker alive.
		let forwarding = false;
		worker.on("newListener", (event) => {
			if (forwarding || (event !== "message" && event !== "error")) return;
			forwarding = true;
			process.on("message", (message, handle) => worker.emit("message", message, handle));
			process.on("error", (error) => worker.emit("error", error));
		});

		const servers = new Set();
		const replies = new Map();
		let seq = 0;
		const onPrimaryGone = () => {
			worker.emit("disconnect");
			if (!worker.exitedAfterDisconnect) process.exit(0);
		};
		const refresh = () => {
			const wanted = servers.size > 0;
			if (wanted && !process._graakChannelWanted) {
				process._graakChannelWanted = true;
				process.once("disconnect", onPrimaryGone);
				process.channel?.ref?.();
			} else if (!wanted && process._graakChannelWanted) {
				process._graakChannelWanted = false;
				process.removeListener("disconnect", onPrimaryGone);
			}
		};

		// Real remote address/port/family for each proxied connection, keyed by the private server's internal port
		// (see route() on the primary side): one FIFO queue of not-yet-matched infos, and one of sockets that beat
		// their info message here, per port. Correlation is by arrival order: the primary sends the "connection"
		// message right when it opens the upstream connection, but the IPC channel and the loopback TCP hop race
		// independently, so a socket can still be accepted before its info arrives. When that happens the socket
		// is held paused (see the "connection" listener below) until the matching info shows up here, so nothing
		// downstream (http, tls, ...) ever reads a byte off it while it would still report the wrong peer.
		const remoteQueues = new Map();
		const remoteBucket = (internalPort) => {
			let bucket = remoteQueues.get(internalPort);
			if (!bucket) remoteQueues.set(internalPort, (bucket = { infos: [], sockets: [] }));
			return bucket;
		};
		const applyRemote = (socket, info) => {
			if (info.address !== undefined) Object.defineProperty(socket, "remoteAddress", { value: info.address, configurable: true });
			if (info.port !== undefined) Object.defineProperty(socket, "remotePort", { value: info.port, configurable: true });
			if (info.family !== undefined) Object.defineProperty(socket, "remoteFamily", { value: info.family, configurable: true });
		};

		process.on("internalMessage", (message) => {
			if (!message || message.cmd !== CMD) return;
			if (message.act === "queryServerReply") {
				const done = replies.get(message.seq);
				replies.delete(message.seq);
				done?.(message);
			} else if (message.act === "disconnect") disconnectWorker();
			else if (message.act === "connection") {
				const bucket = remoteBucket(message.internalPort);
				const socket = bucket.sockets.shift();
				const info = { address: message.address, port: message.port, family: message.family };
				if (socket) {
					applyRemote(socket, info);
					socket.resume();
				} else bucket.infos.push(info);
			}
		});

		function disconnectWorker() {
			worker.exitedAfterDisconnect = true;
			worker.state = "disconnecting";
			let waiting = 1;
			const finish = () => {
				if (--waiting === 0 && process.connected) process.disconnect();
			};
			for (const server of [...servers]) {
				waiting++;
				server.close(finish);
			}
			finish();
		}
		Worker.prototype.disconnect = function disconnect() {
			disconnectWorker();
			return this;
		};
		Worker.prototype.kill = Worker.prototype.destroy = function kill() {
			this.exitedAfterDisconnect = true;
			if (!this.isConnected()) process.exit(0);
			process.once("disconnect", () => process.exit(0));
			send(process, { act: "exitedAfterDisconnect" }, () => process.disconnect());
		};

		const patch = (ServerClass) => {
			if (!ServerClass) return;
			const proto = ServerClass.prototype;
			const originalListen = proto.listen;
			const originalClose = proto.close;
			const originalAddress = proto.address;

			proto.listen = function listen(...args) {
				const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
				const first = args[0];
				let options;
				if (typeof first === "object" && first !== null) {
					if (first.path || first.fd !== undefined || first.handle || first.exclusive || first.signal) options = null;
					else options = { port: first.port ?? 0, host: first.host, backlog: first.backlog };
				} else if (typeof first === "string" && Number.isNaN(Number(first))) options = null;
				else {
					options = { port: first === undefined || first === null ? 0 : Number(first) };
					if (typeof args[1] === "string") options.host = args[1];
					const backlog = args.slice(1).find((value) => typeof value === "number");
					if (backlog !== undefined) options.backlog = backlog;
				}
				if (options === null || this._clusterKey !== undefined) {
					return originalListen.call(this, ...args, ...(callback ? [callback] : []));
				}
				if (callback) this.once("listening", callback);
				this._clusterKey = null;
				const server = this;
				const ownEmit = this.emit;
				this.emit = function emit(event, ...rest) {
					if (event !== "listening") return ownEmit.call(this, event, ...rest);
					delete server.emit;
					server._clusterBegin(options);
					return true;
				};
				originalListen.call(this, { port: 0, host: "127.0.0.1", backlog: options.backlog });
				return this;
			};

			proto._clusterBegin = function begin(options) {
				const internalPort = originalAddress.call(this).port;
				const key = `${options.host ?? ""}:${options.port}`;
				this._clusterKey = key;
				this._clusterPort = internalPort;
				servers.add(this);
				refresh();
				// Match each accepted connection, in arrival order, to the remote-address info the primary sent for
				// it. Runs ahead of the application's own "connection" listener (http/tls attach theirs at
				// construction time, well before this fires) so a socket whose info hasn't arrived yet can be held
				// paused -- nothing downstream reads a byte off it until the real remoteAddress/remotePort are set.
				this.prependListener("connection", (socket) => {
					const bucket = remoteBucket(internalPort);
					const info = bucket.infos.shift();
					if (info) applyRemote(socket, info);
					else {
						socket.pause();
						bucket.sockets.push(socket);
						socket.once("close", () => {
							const index = bucket.sockets.indexOf(socket);
							if (index !== -1) bucket.sockets.splice(index, 1);
						});
					}
				});
				const id = ++seq;
				replies.set(id, (reply) => {
					if (reply.error) {
						this._clusterKey = undefined;
						servers.delete(this);
						refresh();
						originalClose.call(this);
						const error = new Error(`listen ${reply.error.code}: address already in use ${options.host ?? "::"}:${options.port}`);
						error.code = reply.error.code;
						error.syscall = "bind";
						error.address = options.host;
						error.port = options.port;
						this.emit("error", error);
						return;
					}
					this._clusterAddress = reply.address;
					this.emit("listening");
					const address = reply.address;
					send(process, {
						act: "listening",
						addressType: address.family === "IPv6" ? 6 : 4,
						address: address.address,
						port: address.port,
						key,
					});
				});
				send(process, { act: "queryServer", seq: id, key, address: options.host, port: options.port, backlog: options.backlog, internalPort });
			};

			proto.address = function address() {
				if (this._clusterKey !== undefined) return this._clusterAddress ?? null;
				return originalAddress.call(this);
			};

			proto.close = function close(callback) {
				if (this._clusterKey !== undefined) {
					if (this._clusterKey !== null) send(process, { act: "closeServer", key: this._clusterKey, internalPort: this._clusterPort });
					this._clusterKey = undefined;
					this._clusterAddress = undefined;
					servers.delete(this);
					refresh();
				}
				return originalClose.call(this, callback);
			};
		};
		patch(net?.Server);
		patch(tls?.Server);

		send(process, { act: "online" });
	}
}
