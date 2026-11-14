package main

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"www.bamsoftware.com/git/dnstt.git/dns"
	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

// sc-fast12: jalur SlowDNS Xray lewat domain NS kedua. Salin ke paket dnstt-server.

func scRouteReset(t *testing.T) {
	t.Helper()
	reset := func() {
		scXrayDomainFlag, scXrayRouteFlag, scRoutesFileFlag = "", "", ""
		scXrayDomain, scXrayRoutes = nil, nil
		scRouteSSHOff.Store(false)
		scRouteXrayOff.Store(false)
		scRoutesNextCheck, scRoutesModTime, scRoutesSize = 0, 0, 0
		clientEdnsMu.Lock()
		clientRoute = make(map[turbotunnel.ClientID]uint16)
		clientEdnsMu.Unlock()
	}
	reset()
	t.Cleanup(reset)
}

func scRouteSetupFor(t *testing.T, sshDomain, xrayDomain, routes string) dns.Name {
	t.Helper()
	domain, err := dns.ParseName(sshDomain)
	if err != nil {
		t.Fatal(err)
	}
	scXrayDomainFlag, scXrayRouteFlag = xrayDomain, routes
	if err := scRouteSetup(domain); err != nil {
		t.Fatal(err)
	}
	return domain
}

// Query poll dnstt (ClientID + padding) untuk domain mana pun.
func scRouteQuery(tb testing.TB, domainText string, fill byte) ([]byte, turbotunnel.ClientID) {
	tb.Helper()
	domain, err := dns.ParseName(domainText)
	if err != nil {
		tb.Fatal(err)
	}
	var cid turbotunnel.ClientID
	for i := range cid {
		cid[i] = fill
	}
	raw := append(append([]byte(nil), cid[:]...), 0xe0, 0xe0, 0xe0, 0xe0)
	labels := [][]byte{[]byte(strings.ToLower(base32Encoding.EncodeToString(raw)))}
	name, err := dns.NewName(append(labels, domain...))
	if err != nil {
		tb.Fatal(err)
	}
	query := dns.Message{ID: 7, Question: []dns.Question{{Name: name, Type: rrTypeNULL, Class: dns.ClassIN}},
		Additional: []dns.RR{{Type: dns.RRTypeOPT, Class: 1232}}}
	wire, err := query.WireFormat()
	if err != nil {
		tb.Fatal(err)
	}
	return wire, cid
}

func TestSCXrayRoutesParse(t *testing.T) {
	routes, err := scParseXrayRoutes(" /vmess=127.0.0.1:10001, /vless=127.0.0.1:10002,/trojan=[::1]:10003 ")
	if err != nil || len(routes) != 3 || routes["/vless"] != "127.0.0.1:10002" || routes["/trojan"] != "[::1]:10003" {
		t.Fatalf("rute valid ditolak: %v %v", routes, err)
	}
	for _, bad := range []string{
		"", ",", "/vless", "vless=127.0.0.1:10002", "/vl ess=127.0.0.1:1", "/vless?x=127.0.0.1:1",
		"/vless=10.0.0.1:10002", "/vless=example.com:10002", "/vless=127.0.0.1", "/vless=127.0.0.1:0",
	} {
		if _, err := scParseXrayRoutes(bad); err == nil {
			t.Fatalf("rute %q harus ditolak (tujuan non-loopback = proxy terbuka)", bad)
		}
	}
}

func TestSCRouteSetupValidation(t *testing.T) {
	scRouteReset(t)
	domain, _ := dns.ParseName("ns.contoh.com")
	scXrayRouteFlag = "/vless=127.0.0.1:10002"
	if err := scRouteSetup(domain); err == nil {
		t.Fatal("-xray-route tanpa -xray-domain harus ditolak")
	}
	scXrayDomainFlag, scXrayRouteFlag = "NS.Contoh.com", "/vless=127.0.0.1:10002"
	if err := scRouteSetup(domain); err == nil {
		t.Fatal("domain Xray sama dengan domain SSH harus ditolak")
	}
	scXrayDomainFlag, scXrayRouteFlag = "nsx.contoh.com", ""
	if err := scRouteSetup(domain); err == nil {
		t.Fatal("domain Xray tanpa rute harus ditolak")
	}
	scXrayDomainFlag, scXrayRouteFlag = "", ""
	if err := scRouteSetup(domain); err != nil || len(scXrayDomain) != 0 {
		t.Fatalf("tanpa Xray = perilaku lama: %v", err)
	}
}

func TestSCXrayDomainMatching(t *testing.T) {
	scRouteReset(t)
	domain := scRouteSetupFor(t, "ns.contoh.com", "x.ns.contoh.com", "/vless=127.0.0.1:10002")
	name := func(s string) dns.Name {
		n, err := dns.ParseName(s)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	cases := []struct {
		name   string
		xray   bool
		prefix string
		ok     bool
	}{
		{"abc.ns.contoh.com", false, "abc", true},
		{"abc.x.ns.contoh.com", true, "abc", true},
		{"ABC.X.NS.Contoh.COM", true, "ABC", true},
		{"x.ns.contoh.com", true, "", true},
		{"abc.contoh.com", false, "", false},
		{"abc.nsx.contoh.com", false, "", false},
	}
	for _, c := range cases {
		n := name(c.name)
		if got := scXrayWins(n, domain); got != c.xray {
			t.Fatalf("%s: xray=%v, mau %v", c.name, got, c.xray)
		}
		prefix, ok := scTrimTunnelDomain(n, domain)
		if ok != c.ok {
			t.Fatalf("%s: trim ok=%v, mau %v", c.name, ok, c.ok)
		}
		if ok && c.prefix == "" && len(prefix) != 0 {
			t.Fatalf("%s: prefix harus kosong, dapat %q", c.name, prefix)
		}
		if ok && c.prefix != "" && (len(prefix) != 1 || string(prefix[0]) != c.prefix) {
			t.Fatalf("%s: prefix %q, mau %q", c.name, prefix, c.prefix)
		}
	}
	// Domain Xray terpisah (bukan turunan domain SSH).
	scRouteReset(t)
	domain = scRouteSetupFor(t, "ns.contoh.com", "nsx.contoh.com", "/vless=127.0.0.1:10002")
	if !scXrayWins(name("q.nsx.contoh.com"), domain) || scXrayWins(name("q.ns.contoh.com"), domain) {
		t.Fatal("domain terpisah salah dipetakan")
	}
}

func TestSCParseRoutesDefaultsOn(t *testing.T) {
	for _, c := range []struct {
		data       string
		ssh, xray bool
	}{
		{"", true, true},
		{"ENABLED=1\nROUTE_SSH=1\nROUTE_XRAY=1\n", true, true},
		{"ROUTE_SSH=0\nROUTE_XRAY=1\n", false, true},
		{"ROUTE_SSH=1\r\nROUTE_XRAY=0\r\n", true, false},
		{"ROUTE_SSH=rusak\nROUTE_XRAY=\n", true, true},
	} {
		ssh, xray := scParseRoutes([]byte(c.data))
		if ssh != c.ssh || xray != c.xray {
			t.Fatalf("%q: ssh=%v xray=%v", c.data, ssh, xray)
		}
	}
}

func TestSCQueryRouteFollowsRoutesFile(t *testing.T) {
	scRouteReset(t)
	file := filepath.Join(t.TempDir(), "slowdns.state")
	if err := os.WriteFile(file, []byte("ROUTE_SSH=1\nROUTE_XRAY=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	scRoutesFileFlag = file
	domain := scRouteSetupFor(t, "ns.contoh.com", "nsx.contoh.com", "/vless=127.0.0.1:10002")
	msg := func(n string) *dns.Message {
		name, _ := dns.ParseName(n)
		return &dns.Message{Question: []dns.Question{{Name: name, Type: rrTypeNULL, Class: dns.ClassIN}}}
	}
	if scQueryRoute(msg("a.ns.contoh.com"), domain) != scRouteSSH || scQueryRoute(msg("a.nsx.contoh.com"), domain) != scRouteXray {
		t.Fatal("rute awal salah")
	}
	if err := os.WriteFile(file, []byte("ROUTE_SSH=1\nROUTE_XRAY=0\nPAD=xx\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	scRoutesNextCheck = 0 // lewati jeda 3 detik
	if scQueryRoute(msg("a.nsx.contoh.com"), domain) != scRouteRefused || scQueryRoute(msg("a.ns.contoh.com"), domain) != scRouteSSH {
		t.Fatal("jalur Xray OFF harus ditolak, SSH tetap jalan")
	}
	// File rusak/hilang tidak pernah mematikan layanan yang ON.
	os.Remove(file)
	scRoutesNextCheck = 0
	if scQueryRoute(msg("a.ns.contoh.com"), domain) != scRouteSSH {
		t.Fatal("file hilang tidak boleh mengubah status")
	}
}

func TestSCRecvLoopRoutesSessions(t *testing.T) {
	scRouteReset(t)
	domain := scRouteSetupFor(t, "ns.contoh.com", "nsx.contoh.com", "/vless=127.0.0.1:10002")
	wireX, cidX := scRouteQuery(t, "nsx.contoh.com", 0x51)
	wireS, cidS := scRouteQuery(t, "ns.contoh.com", 0x52)
	defer clientEdnsForget(cidX)
	defer clientEdnsForget(cidS)
	tt := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
	defer tt.Close()
	records := make(chan *record, 4)
	if err := recvLoop(domain, &scRecvConn{packets: [][]byte{wireX, wireS}, limit: 2}, tt, records); err != io.EOF {
		t.Fatal(err)
	}
	clientEdnsMu.Lock()
	routeX, routeS := clientRoute[cidX], clientRoute[cidS]
	clientEdnsMu.Unlock()
	if routeX != scRouteXray || routeS != 0 {
		t.Fatalf("rute ClientID: xray=%d ssh=%d", routeX, routeS)
	}
	for i := 0; i < 2; i++ {
		if r := <-records; r.Resp.Rcode() != dns.RcodeNoError {
			t.Fatalf("query jalur ON harus dijawab normal: rcode %d", r.Resp.Rcode())
		}
	}
	// Jalur Xray OFF: NXDOMAIN, tanpa entri ClientID baru (tidak ada sesi).
	scRouteXrayOff.Store(true)
	wireX2, cidX2 := scRouteQuery(t, "nsx.contoh.com", 0x53)
	defer clientEdnsForget(cidX2)
	if err := recvLoop(domain, &scRecvConn{packets: [][]byte{wireX2}, limit: 1}, tt, records); err != io.EOF {
		t.Fatal(err)
	}
	if r := <-records; r.Resp.Rcode() != dns.RcodeNameError {
		t.Fatalf("jalur OFF harus NXDOMAIN, dapat %d", r.Resp.Rcode())
	}
	clientEdnsMu.Lock()
	_, known := clientEdns[cidX2]
	clientEdnsMu.Unlock()
	if known {
		t.Fatal("query jalur OFF tidak boleh mencatat ClientID")
	}
	// clientEdnsForget ikut membuang rute.
	clientEdnsForget(cidX)
	clientEdnsMu.Lock()
	_, still := clientRoute[cidX]
	clientEdnsMu.Unlock()
	if still {
		t.Fatal("rute harus dibuang bersama entri ClientID")
	}
}

func TestSCXrayTarget(t *testing.T) {
	scRouteReset(t)
	scRouteSetupFor(t, "ns.contoh.com", "nsx.contoh.com", "/vmess=127.0.0.1:10001,/vless=127.0.0.1:10002")
	for line, want := range map[string]string{
		"GET /vless HTTP/1.1\r\n":          "127.0.0.1:10002",
		"GET /vmess?ed=2048 HTTP/1.1\r\n":  "127.0.0.1:10001",
		"GET /vless#x HTTP/1.0\n":          "127.0.0.1:10002",
		"POST /vless HTTP/1.1\r\n":         "",
		"GET /trojan HTTP/1.1\r\n":         "",
		"GET /vless\r\n":                   "",
		"GET  /vless HTTP/1.1\r\n":         "",
		"SSH-2.0-OpenSSH_9.6\r\n":          "",
		"GET /vlessx HTTP/1.1\r\n":         "",
		"GET http://h/vless HTTP/1.1\r\n": "",
	} {
		got, ok := scXrayTarget([]byte(line))
		if got != want || ok != (want != "") {
			t.Fatalf("%q -> %q/%v, mau %q", line, got, ok, want)
		}
	}
}

// Stream Xray tercatat di monitor sebagai baris "X|..." dan hilang saat putus;
// tidak tercampur dengan stream SSH yang kebetulan memakai port sama.
func TestSCXrayStreamMonitorLines(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	saved := scMonitorEnabled
	scMonitorEnabled = true
	defer func() { scMonitorEnabled = saved }()
	s := scTrackXrayStream(conn.(*net.TCPConn), "0123456789abcdef")
	if s == nil {
		t.Fatal("stream Xray tidak tercatat")
	}
	scSessionWriter(conn.(*net.TCPConn), s).Write([]byte("GET /vless HTTP/1.1\r\n"))
	snap := string(scSessionSnapshot())
	port := conn.LocalAddr().(*net.TCPAddr).Port
	if !strings.Contains(snap, "\nX|"+itoa(port)+"|0123456789abcdef|21|") || !strings.HasPrefix(snap, "SC_SLOWDNS_SESSIONS_V2|") {
		t.Fatalf("baris X tidak ada:\n%s", snap)
	}
	scUntrackXrayStream(s)
	if strings.Contains(string(scSessionSnapshot()), "\nX|") {
		t.Fatal("stream Xray yang putus harus hilang dari monitor")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
