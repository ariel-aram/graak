import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error the runtime files are plain JavaScript without declarations
import { parseIpconfig, parseNslookup, parseResolvConf } from "../quickjs/runtime/node-dns.js";

test("parseIpconfig handles Windows XP and 7 English outputs", () => {
	const xp = `
Windows IP Configuration

        Host Name . . . . . . . . . . . . : WINXP-VM
        Primary Dns Suffix  . . . . . . . : 
        Node Type . . . . . . . . . . . . : Unknown
        IP Routing Enabled. . . . . . . . : No
        WINS Proxy Enabled. . . . . . . . : No

Ethernet adapter Local Area Connection:

        Connection-specific DNS Suffix  . : local
        Description . . . . . . . . . . . : Intel(R) PRO/1000 MT Network Connection
        Physical Address. . . . . . . . . : 08-00-27-88-99-AA
        Dhcp Enabled. . . . . . . . . . . : Yes
        Autoconfiguration Enabled . . . . : Yes
        IP Address. . . . . . . . . . . . : 192.168.1.150
        Subnet Mask . . . . . . . . . . . : 255.255.255.0
        Default Gateway . . . . . . . . . : 192.168.1.1
        DHCP Server . . . . . . . . . . . : 192.168.1.1
        DNS Servers . . . . . . . . . . . : 192.168.1.1
                                            192.168.1.2
        Primary WINS Server . . . . . . . : 10.0.0.1
        Lease Obtained. . . . . . . . . . : Monday, September 21, 2026 10:00:00 AM
        Lease Expires . . . . . . . . . . : Tuesday, September 22, 2026 10:00:00 AM
`;
	assert.deepEqual(parseIpconfig(xp), ["192.168.1.1", "192.168.1.2"]);

	const win7 = `
Windows IP Configuration

   Host Name . . . . . . . . . . . . : Win7-PC
   Primary Dns Suffix  . . . . . . . : 
   Node Type . . . . . . . . . . . . : Hybrid
   IP Routing Enabled. . . . . . . . : No
   WINS Proxy Enabled. . . . . . . . : No

Ethernet adapter Local Area Connection:

   Connection-specific DNS Suffix  . : lan
   Description . . . . . . . . . . . : Realtek PCIe GBE Family Controller
   Physical Address. . . . . . . . . : 00-1A-2B-3C-4D-5E
   DHCP Enabled. . . . . . . . . . . : Yes
   Autoconfiguration Enabled . . . . : Yes
   IPv4 Address. . . . . . . . . . . : 10.0.2.15(Preferred) 
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 10.0.2.2
   DHCP Server . . . . . . . . . . . : 10.0.2.2
   DNS Servers . . . . . . . . . . . : 10.0.2.3
                                       8.8.8.8
                                       8.8.4.4
   NetBIOS over Tcpip. . . . . . . . : Enabled
`;
	assert.deepEqual(parseIpconfig(win7), ["10.0.2.3", "8.8.8.8", "8.8.4.4"]);
});

test("parseIpconfig handles localized Windows outputs", () => {
	// Spanish
	const es = `
Configuración IP de Windows

Adaptador de Ethernet Conexión de área local:

   Sufijo DNS específico para la conexión. . : mi-red
   Vínculo: dirección IPv6 local. . . : fe80::d4a8:6431:d2d8:d9c3%11
   Dirección IPv4. . . . . . . . . . . . . . : 192.168.0.50
   Máscara de subred . . . . . . . . . . . . : 255.255.255.0
   Puerta de enlace predeterminada . . . . . : 192.168.0.1
   Servidores DNS. . . . . . . . . . . . . . : 192.168.0.1
                                               1.1.1.1
`;
	assert.deepEqual(parseIpconfig(es), ["192.168.0.1", "1.1.1.1"]);

	// German
	const de = `
Windows-IP-Konfiguration

Ethernet-Adapter LAN-Verbindung:

   Verbindungsspezifisches DNS-Suffix: fritz.box
   IPv4-Adresse  . . . . . . . . . . : 192.168.178.20
   Subnetzmaske  . . . . . . . . . . : 255.255.255.0
   Standardgateway . . . . . . . . . : 192.168.178.1
   DNS-Server  . . . . . . . . . . . : 192.168.178.1
                                       192.168.178.2
`;
	assert.deepEqual(parseIpconfig(de), ["192.168.178.1", "192.168.178.2"]);

	// French
	const fr = `
Configuration IP de Windows

Carte Ethernet Connexion au réseau local :

   Suffixe DNS propre à la connexion. . . : home
   Adresse IPv4. . . . . . . . . . . : 192.168.1.42
   Masque de sous-réseau. . . . . . . . . . : 255.255.255.0
   Passerelle par défaut. . . . . . . . . . : 192.168.1.254
   Serveurs DNS. . . . . . . . . . . . . : 192.168.1.254
`;
	assert.deepEqual(parseIpconfig(fr), ["192.168.1.254"]);

	// Chinese
	const zh = `
Windows IP 配置

以太网适配器 以太网:

   连接特定的 DNS 后缀 . . . . . . . : lan
   本地链接 IPv6 地址. . . . . . . . : fe80::591:d933:e3b0:14aa%4
   IPv4 地址 . . . . . . . . . . . . : 192.168.31.100
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : 192.168.31.1
   DNS 服务器  . . . . . . . . . . . : 114.114.114.114
                                       8.8.8.8
`;
	assert.deepEqual(parseIpconfig(zh), ["114.114.114.114", "8.8.8.8"]);
});

test("parseIpconfig handles IPv6 and scope IDs", () => {
	const ipv6Output = `
Windows IP Configuration

Ethernet adapter vEth:

   Connection-specific DNS Suffix  . : corp.example.com
   DNS Servers . . . . . . . . . . . : 2001:4860:4860::8888
                                       2001:4860:4860::8844%1
                                       192.168.1.1
`;
	assert.deepEqual(parseIpconfig(ipv6Output), ["2001:4860:4860::8888", "2001:4860:4860::8844", "192.168.1.1"]);
});

test("parseResolvConf handles POSIX /etc/resolv.conf", () => {
	const conf = `
# Dynamic resolv.conf file for glibc resolver
; Alternate comment style
nameserver 127.0.0.53
nameserver 1.1.1.1
nameserver 2606:4700:4700::1111%eth0
search home.arpa
options edns0
`;
	assert.deepEqual(parseResolvConf(conf), {
		servers: ["127.0.0.53", "1.1.1.1", "2606:4700:4700::1111%eth0"],
		timeout: undefined,
		tries: undefined,
	});
});

test("parseIpconfig handles Vista and 7 adapters with IPv6, tunnels and the fec0 placeholders", () => {
	const vista = `
Windows IP Configuration

   Host Name . . . . . . . . . . . . : vista-pc
   Primary Dns Suffix  . . . . . . . :
   Node Type . . . . . . . . . . . . : Hybrid
   IP Routing Enabled. . . . . . . . : No
   WINS Proxy Enabled. . . . . . . . : No
   DNS Suffix Search List. . . . . . : lan

Ethernet adapter Local Area Connection:

   Connection-specific DNS Suffix  . : lan
   Description . . . . . . . . . . . : NVIDIA nForce Networking Controller
   Physical Address. . . . . . . . . : 00-1B-FC-11-22-33
   DHCP Enabled. . . . . . . . . . . : Yes
   Autoconfiguration Enabled . . . . : Yes
   Link-local IPv6 Address . . . . . : fe80::a1b2:c3d4:e5f6:1234%10(Preferred)
   IPv4 Address. . . . . . . . . . . : 192.168.0.10(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Lease Obtained. . . . . . . . . . : Monday, September 21, 2026 10:00:00 AM
   Default Gateway . . . . . . . . . : fe80::1%10
                                       192.168.0.1
   DHCP Server . . . . . . . . . . . : 192.168.0.1
   DHCPv6 IAID . . . . . . . . . . . : 234881024
   DNS Servers . . . . . . . . . . . : fe80::1%10
                                       192.168.0.1
   NetBIOS over Tcpip. . . . . . . . : Enabled

Tunnel adapter Local Area Connection* 6:

   Media State . . . . . . . . . . . : Media disconnected
   Connection-specific DNS Suffix  . :
   Description . . . . . . . . . . . : isatap.lan

Tunnel adapter Local Area Connection* 7:

   Connection-specific DNS Suffix  . :
   Description . . . . . . . . . . . : Teredo Tunneling Pseudo-Interface
   IPv6 Address. . . . . . . . . . . : 2001:0:4136:e378:8000:63bf:3f57:fdf2(Preferred)
   Link-local IPv6 Address . . . . . : fe80::8000:63bf:3f57:fdf2%11(Preferred)
   Default Gateway . . . . . . . . . : ::
   DNS Servers . . . . . . . . . . . : fec0:0:0:ffff::1%1
                                       fec0:0:0:ffff::2%1
                                       fec0:0:0:ffff::3%1
   NetBIOS over Tcpip. . . . . . . . : Disabled
`;
	// The link-local server keeps its zone (the socket needs the interface) and goes after the plain ones.
	assert.deepEqual(parseIpconfig(vista), ["192.168.0.1", "fe80::1%10"]);
});

test("parseIpconfig handles German Windows XP output", () => {
	const xpDe = `
Windows-IP-Konfiguration

        Hostname. . . . . . . . . . . . . : xp-de
        Primäres DNS-Suffix . . . . . . . :
        Knotentyp . . . . . . . . . . . . : Unbekannt
        IP-Routing aktiviert. . . . . . . : Nein
        WINS-Proxy aktiviert. . . . . . . : Nein

Ethernetadapter LAN-Verbindung:

        Verbindungsspezifisches DNS-Suffix: fritz.box
        Beschreibung. . . . . . . . . . . : AMD PCNET Family PCI Ethernet Adapter
        Physikalische Adresse . . . . . . : 08-00-27-12-34-56
        DHCP aktiviert. . . . . . . . . . : Ja
        Autokonfiguration aktiviert . . . : Ja
        IP-Adresse. . . . . . . . . . . . : 192.168.178.33
        Subnetzmaske. . . . . . . . . . . : 255.255.255.0
        Standardgateway . . . . . . . . . : 192.168.178.1
        DHCP-Server . . . . . . . . . . . : 192.168.178.1
        DNS-Server. . . . . . . . . . . . : 192.168.178.1
        Lease erhalten. . . . . . . . . . : Montag, 21. September 2026 10:00:00
`;
	assert.deepEqual(parseIpconfig(xpDe), ["192.168.178.1"]);
	assert.deepEqual(parseIpconfig(xpDe.replace(/\n/g, "\r\n")), ["192.168.178.1"]);
});

test("parseNslookup reads the default server in any language", () => {
	assert.deepEqual(parseNslookup("Default Server:  router.lan\r\nAddress:  192.168.1.1\r\n\r\n> "), ["192.168.1.1"]);
	assert.deepEqual(parseNslookup("Standardserver:  UnKnown\r\nAddress:  fd00::1\r\n\r\n> "), ["fd00::1"]);
	assert.deepEqual(
		parseNslookup("*** Default servers are not available\r\nDefault Server:  UnKnown\r\nAddress:  127.0.0.1\r\n"),
		["127.0.0.1"]
	);
});

test("parseResolvConf reads timeout and attempts", () => {
	assert.deepEqual(parseResolvConf("nameserver 10.0.0.2 # office\noptions timeout:3 attempts:2 rotate\n"), {
		servers: ["10.0.0.2"],
		timeout: 3000,
		tries: 2,
	});
});
