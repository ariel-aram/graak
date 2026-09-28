// node:cluster: primary and worker roles, fork(), worker events and methods, shared listening on one port.
// Must print exactly what Node.js prints. The same file is the worker (`cluster.isWorker`).
const cluster = require("cluster");
const http = require("http");
const net = require("net");

if (cluster.isWorker) {
	const port = Number(process.env.CORPUS_PORT);
	const mode = process.env.CORPUS_MODE;
	const worker = cluster.worker;
	if (mode === "busy") {
		const server = net.createServer();
		server.on("error", (error) => {
			process.send({ busy: error.code, syscall: error.syscall });
			worker.disconnect();
		});
		server.listen(port);
	} else if (mode === "plain") {
		process.send({
			plain: true,
			isWorker: cluster.isWorker,
			isPrimary: cluster.isPrimary,
			isMaster: cluster.isMaster,
			id: worker.id,
			envId: process.env.NODE_UNIQUE_ID,
			sameProcess: worker.process === process,
			workers: cluster.workers,
			args: process.argv.slice(2),
		});
		worker.on("message", (m) => {
			process.send({ echo: m, viaWorker: true });
			if (m === "bye") worker.disconnect();
		});
	} else {
		const server = http.createServer((req, res) =>
			res.end(
				JSON.stringify({
					id: worker.id,
					remoteAddress: req.socket.remoteAddress,
					remotePort: req.socket.remotePort,
					remoteFamily: req.socket.remoteFamily,
				}),
			),
		);
		server.listen(port, () => {
			process.send({ listening: server.address().port, id: worker.id });
		});
		process.on("message", (m) => {
			if (m === "exit3") process.exit(3);
			else process.send({ echo: m });
		});
	}
} else {
	main().catch((error) => {
		console.log("FAILED", error && error.stack);
		process.exit(1);
	});
}

async function main() {
	const out = [];
	const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	const once = (emitter, event) => new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
	const nextMessage = (worker, pick) =>
		new Promise((resolve) => {
			const on = (m) => {
				if (pick(m)) {
					worker.removeListener("message", on);
					resolve(m);
				}
			};
			worker.on("message", on);
		});
	const get = (port) =>
		new Promise((resolve, reject) => {
			http
				.get({ port, host: "127.0.0.1", agent: false }, (res) => {
					let body = "";
					res.on("data", (d) => (body += d));
					res.on("end", () => resolve(body));
				})
				.on("error", reject);
		});
	const getWithLocalPort = (port) =>
		new Promise((resolve, reject) => {
			const req = http.get({ port, host: "127.0.0.1", agent: false }, (res) => {
				const localPort = res.socket.localPort;
				let body = "";
				res.on("data", (d) => (body += d));
				res.on("end", () => resolve({ body, localPort }));
			});
			req.on("error", reject);
		});
	const freePort = () =>
		new Promise((resolve) => {
			const s = net.createServer();
			s.listen(0, "127.0.0.1", () => {
				const { port } = s.address();
				s.close(() => resolve(port));
			});
		});

	say("roles", cluster.isPrimary, cluster.isMaster, cluster.isWorker);
	say("api", typeof cluster.fork, typeof cluster.setupPrimary, typeof cluster.setupMaster, typeof cluster.disconnect, typeof cluster.Worker);
	say("before", cluster.settings, cluster.workers, cluster.worker, cluster.SCHED_NONE, cluster.SCHED_RR);
	say("policy", cluster.schedulingPolicy === (process.platform === "win32" ? cluster.SCHED_NONE : cluster.SCHED_RR));

	// ---- setupPrimary and settings ------------------------------------------------------------------------------------
	{
		const setup = once(cluster, "setup");
		cluster.setupPrimary({ args: ["one", "two"], silent: false });
		const [settings] = await setup;
		say("setup", settings.args, settings.silent, settings.exec === process.argv[1], Array.isArray(settings.execArgv));
		say("settings", Object.keys(cluster.settings).sort(), cluster.settings.args);
		say("alias", cluster.setupMaster === cluster.setupPrimary);
	}

	// ---- a plain worker: environment, events, messages --------------------------------------------------------------
	{
		const events = [];
		const forked = once(cluster, "fork");
		const worker = cluster.fork({ CORPUS_MODE: "plain" });
		say("forked", worker instanceof cluster.Worker, worker.id, typeof worker.process.pid, worker.state, cluster.workers[1] === worker);
		say("flags", worker.isConnected(), worker.isDead(), worker.exitedAfterDisconnect);
		const [viaEvent] = await forked;
		say("fork event", viaEvent === worker);
		for (const name of ["online", "disconnect", "exit"]) worker.on(name, () => events.push(name));
		await once(worker, "online");
		say("online", worker.state);
		const first = await nextMessage(worker, (m) => m && m.plain);
		say("worker saw", first);
		const clusterMessage = once(cluster, "message");
		worker.send("ping");
		const echoed = await nextMessage(worker, (m) => m && m.echo !== undefined);
		const [from, message] = await clusterMessage;
		say("echo", echoed, from === worker, message);
		const exited = once(worker, "exit");
		const disconnected = once(cluster, "disconnect");
		const result = worker.disconnect();
		say("disconnect returns", result === worker, worker.exitedAfterDisconnect, cluster.workers[worker.id]);
		const [code, signal] = await exited;
		await disconnected;
		say("exit", code, signal, worker.state, worker.isDead(), worker.isConnected(), worker.exitedAfterDisconnect);
		say("events", events);
		say("workers now", Object.keys(cluster.workers));
	}

	// ---- two workers listening on one port --------------------------------------------------------------------------------
	const port = await freePort();
	const workers = [];
	{
		const seen = [];
		const listening = new Promise((resolve) => {
			const on = (worker, address) => {
				seen.push([address.port === port, address.addressType, worker.state]);
				if (seen.length === 2) {
					cluster.removeListener("listening", on);
					resolve();
				}
			};
			cluster.on("listening", on);
		});
		for (let i = 0; i < 2; i++) workers.push(cluster.fork({ CORPUS_PORT: String(port), CORPUS_MODE: "http" }));
		const announced = workers.map((worker) => nextMessage(worker, (m) => m && m.listening));
		await listening;
		say("listening", seen.length, seen.every((s) => s[0]), seen.map((s) => s[2]));
		const reported = [];
		for (const promise of announced) reported.push((await promise).listening === port);
		say("worker address", reported);

		const answers = new Set();
		for (let i = 0; i < 8; i++) answers.add(JSON.parse(await get(port)).id);
		say("served by", [...answers].sort().length, [...answers].every((a) => workers.some((w) => w.id === a)));

		// The proxied connection a worker sees must report the real client's address/port, not the primary's
		// loopback proxy hop's own (unrelated, ephemeral) source port.
		const { body: remoteBody, localPort: clientLocalPort } = await getWithLocalPort(port);
		const remote = JSON.parse(remoteBody);
		say(
			"remote address",
			remote.remotePort === clientLocalPort,
			remote.remoteAddress === "127.0.0.1" || remote.remoteAddress === "::1" || remote.remoteAddress === "::ffff:127.0.0.1",
			typeof remote.remoteFamily,
		);

		const reply = nextMessage(workers[0], (m) => m && m.echo !== undefined);
		workers[0].send({ n: 1 });
		say("message", await reply);
	}

	// ---- a worker that exits by itself ------------------------------------------------------------------------------------
	{
		const worker = workers[0];
		const order = [];
		worker.on("disconnect", () => order.push("disconnect"));
		worker.on("exit", (code, signal) => order.push(`exit ${code} ${signal}`));
		const gone = once(worker, "exit");
		worker.send("exit3");
		await gone;
		await new Promise((resolve) => setTimeout(resolve, 100));
		say("crash", order, worker.exitedAfterDisconnect, worker.state, Object.keys(cluster.workers).length);
		const answers = new Set();
		for (let i = 0; i < 4; i++) answers.add(JSON.parse(await get(port)).id);
		say("survivor serves", [...answers], workers[1].id);
	}

	// ---- a busy port -------------------------------------------------------------------------------------------------------
	{
		const holder = net.createServer();
		await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
		const busyPort = holder.address().port;
		const worker = cluster.fork({ CORPUS_PORT: String(busyPort), CORPUS_MODE: "busy" });
		const exited = once(worker, "exit");
		const message = await nextMessage(worker, (m) => m && m.busy);
		say("busy", message);
		await exited;
		await new Promise((resolve) => holder.close(resolve));
	}

	// ---- cluster.disconnect ------------------------------------------------------------------------------------------------
	{
		const exits = once(workers[1], "exit");
		await new Promise((resolve) => cluster.disconnect(resolve));
		const [code, signal] = await exits;
		say("cluster.disconnect", code, signal, workers[1].exitedAfterDisconnect, Object.keys(cluster.workers));
		await new Promise((resolve) => cluster.disconnect(resolve));
		say("cluster.disconnect again");
	}

	console.log(out.join("\n"));
}
