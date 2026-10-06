package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"io"
	"io/ioutil"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type backendHit struct {
	name   string
	header string
	data   []byte
}

func listenLocal(t *testing.T) net.Listener {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

func portOf(ln net.Listener) int { return ln.Addr().(*net.TCPAddr).Port }

// Xray tiruan: catat header, jawab 101 (atau status lain), kirim satu frame
// server, lalu catat byte berikutnya dari mux.
func fakeXray(t *testing.T, name string, status string, hits chan backendHit) net.Listener {
	ln := listenLocal(t)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				var hdr bytes.Buffer
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					hdr.WriteString(line)
					if line == "\r\n" {
						break
					}
				}
				if status != "101" {
					_, _ = c.Write([]byte("HTTP/1.1 " + status + " Not Found\r\nContent-Length: 0\r\n\r\n"))
					hits <- backendHit{name: name, header: hdr.String()}
					return
				}
				_, _ = c.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: xray\r\n\r\n\x82\x03abc"))
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				buf := make([]byte, 4096)
				n, _ := io.ReadAtLeast(r, buf, 1)
				hits <- backendHit{name: name, header: hdr.String(), data: buf[:n]}
			}(c)
		}
	}()
	return ln
}

func fakeSSH(t *testing.T, hits chan backendHit) net.Listener {
	ln := listenLocal(t)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = c.Write([]byte("SSH-2.0-fake\r\n"))
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				buf := make([]byte, 4096)
				n, _ := io.ReadAtLeast(c, buf, 1)
				hits <- backendHit{name: "ssh", data: buf[:n]}
			}(c)
		}
	}()
	return ln
}

type harness struct {
	mux  net.Listener
	hits chan backendHit
	stop []net.Listener
}

func newHarness(t *testing.T, xrayStatus string) *harness {
	h := &harness{hits: make(chan backendHit, 8)}
	vm := fakeXray(t, "vmess", xrayStatus, h.hits)
	vl := fakeXray(t, "vless", xrayStatus, h.hits)
	tr := fakeXray(t, "trojan", xrayStatus, h.hits)
	ssh := fakeSSH(t, h.hits)
	xrayHost = "127.0.0.1"
	xrayRoutes = map[string]xrayRoute{
		"vmess":  {name: "vmess", port: portOf(vm), path: "/vmess"},
		"vless":  {name: "vless", port: portOf(vl), path: "/vless"},
		"trojan": {name: "trojan", port: portOf(tr), path: "/trojan"},
	}
	h.mux = listenLocal(t)
	sshPort := portOf(ssh)
	go func() {
		for {
			c, err := h.mux.Accept()
			if err != nil {
				return
			}
			go handleConn(c, "127.0.0.1", sshPort, "127.0.0.1", 1, 8192, 30)
		}
	}()
	h.stop = []net.Listener{vm, vl, tr, ssh, h.mux}
	return h
}

func (h *harness) close() {
	for _, l := range h.stop {
		_ = l.Close()
	}
}

func (h *harness) wait(t *testing.T) backendHit {
	select {
	case hit := <-h.hits:
		return hit
	case <-time.After(4 * time.Second):
		t.Fatal("backend tidak menerima koneksi")
	}
	return backendHit{}
}

func (h *harness) open(t *testing.T, request string) (net.Conn, *bufio.Reader, string) {
	c, err := net.Dial("tcp", h.mux.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(c)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var resp bytes.Buffer
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("respons 101 tidak datang: %v (%q)", err, resp.String())
		}
		resp.WriteString(line)
		if line == "\r\n" {
			break
		}
	}
	return c, r, resp.String()
}

const testKey = "dGhlIHNhbXBsZSBub25jZQ=="

func wsRequest(path string, extra string) string {
	return "GET " + path + " HTTP/1.1\r\nHost: vpn.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + testKey + "\r\nSec-WebSocket-Version: 13\r\n" + extra + "\r\n"
}

func maskedFrame(payload []byte) []byte {
	mask := []byte{0x11, 0x22, 0x33, 0x44}
	var b bytes.Buffer
	b.WriteByte(0x82)
	switch {
	case len(payload) < 126:
		b.WriteByte(0x80 | byte(len(payload)))
	default:
		b.WriteByte(0x80 | 126)
		b.WriteByte(byte(len(payload) >> 8))
		b.WriteByte(byte(len(payload)))
	}
	b.Write(mask)
	for i, c := range payload {
		b.WriteByte(c ^ mask[i%4])
	}
	return b.Bytes()
}

func vmessLikePayload() []byte {
	p := make([]byte, 48)
	for i := range p {
		p[i] = byte(0x9c + i*7)
	}
	return p
}

func trojanPayload(size int) []byte {
	p := []byte(strings.Repeat("a1", 28) + "\r\n")
	for len(p) < size {
		p = append(p, 0x01)
	}
	return p
}

const knownVless = "b831381d-6324-4d53-ad4f-8cda48b30811"

func vlessPayload(id string) []byte {
	raw, _ := hex.DecodeString(strings.Replace(id, "-", "", -1))
	return append(append([]byte{0x00}, raw...), 0x00, 0x01, 0x01, 0xbb, 0x01, 0x7f, 0x00, 0x00, 0x01)
}

func setup(t *testing.T) func() {
	dir, err := ioutil.TempDir("", "mux-test")
	if err != nil {
		t.Fatal(err)
	}
	cfg := `{"inbounds":[{"tag":"vless-ws","protocol":"vless","settings":{"clients":[{"id":"` + knownVless + `","email":"a"},{"id":"abc","email":"b"}]}},{"tag":"vmess-ws","protocol":"vmess","settings":{"clients":[{"id":"11111111-1111-1111-1111-111111111111"}]}}]}`
	path := filepath.Join(dir, "config.json")
	if err := ioutil.WriteFile(path, []byte(cfg), 0600); err != nil {
		t.Fatal(err)
	}
	xrayConfigPaths = []string{path}
	vlessCheckedAt = time.Time{}
	vlessFileStamp = ""
	vlessIDs = nil
	multipathEnabled = true
	xrayRealIPEnabled = false
	firstFrameWait = 300 * time.Millisecond
	return func() { _ = os.RemoveAll(dir) }
}

func expectAccept(t *testing.T, resp string) {
	if !strings.HasPrefix(resp, "HTTP/1.1 101") || !strings.Contains(resp, "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") {
		t.Fatalf("101 harus memuat Sec-WebSocket-Accept yang benar:\n%s", resp)
	}
}

func routeCase(t *testing.T, path string, payload []byte, want string) {
	defer setup(t)()
	h := newHarness(t, "101")
	defer h.close()
	c, r, resp := h.open(t, wsRequest(path, ""))
	defer c.Close()
	expectAccept(t, resp)
	frame := maskedFrame(payload)
	if _, err := c.Write(frame); err != nil {
		t.Fatal(err)
	}
	hit := h.wait(t)
	if hit.name != want {
		t.Fatalf("path %s: diteruskan ke %s, seharusnya %s", path, hit.name, want)
	}
	if !strings.HasPrefix(hit.header, "GET /"+want+" HTTP/1.1\r\n") {
		t.Fatalf("baris request ke Xray harus memakai path standar:\n%s", hit.header)
	}
	if !strings.Contains(hit.header, "Sec-WebSocket-Key: "+testKey) || !strings.Contains(hit.header, "Host: vpn.example.com") {
		t.Fatalf("header WebSocket asli harus ikut diteruskan:\n%s", hit.header)
	}
	if !bytes.Equal(hit.data, frame) {
		t.Fatalf("frame pertama harus sampai utuh ke Xray: %x vs %x", hit.data, frame)
	}
	got := make([]byte, 5)
	if _, err := io.ReadFull(r, got); err != nil || string(got) != "\x82\x03abc" {
		t.Fatalf("frame dari Xray harus sampai ke klien: %q %v", got, err)
	}
}

func TestVmessAnyPath(t *testing.T)  { routeCase(t, "/bebas", vmessLikePayload(), "vmess") }
func TestTrojanAnyPath(t *testing.T) { routeCase(t, "/worryfree?ed=2048", trojanPayload(70), "trojan") }
func TestTrojanLongFrame(t *testing.T) {
	routeCase(t, "/anjay", trojanPayload(300), "trojan")
}
func TestVlessKnownID(t *testing.T) { routeCase(t, "/", vlessPayload(knownVless), "vless") }
func TestVlessCustomID(t *testing.T) {
	id, _ := parseXrayID("abc")
	routeCase(t, "/x", append(append([]byte{0}, id[:]...), 0, 1), "vless")
}
func TestUnknownVlessIDGoesToVmess(t *testing.T) {
	routeCase(t, "/x", vlessPayload("22222222-2222-2222-2222-222222222222"), "vmess")
}

func TestVlessWithoutConfig(t *testing.T) {
	defer setup(t)()
	xrayConfigPaths = []string{"/tidak/ada/config.json"}
	if got := classifyXrayPayload(vlessPayload("22222222-2222-2222-2222-222222222222")); got != "vless" {
		t.Fatalf("tanpa config, versi 0 dianggap VLESS, dapat %s", got)
	}
}

func TestEarlyData(t *testing.T) {
	defer setup(t)()
	h := newHarness(t, "101")
	defer h.close()
	ed := base64.RawURLEncoding.EncodeToString(vlessPayload(knownVless))
	c, _, resp := h.open(t, wsRequest("/ed?ed=2048", "Sec-WebSocket-Protocol: "+ed+"\r\n"))
	defer c.Close()
	expectAccept(t, resp)
	if !strings.Contains(resp, "Sec-WebSocket-Protocol: "+ed) {
		t.Fatalf("early data harus digaungkan di 101:\n%s", resp)
	}
	_, _ = c.Write(maskedFrame([]byte("lanjut")))
	hit := h.wait(t)
	if hit.name != "vless" || !strings.Contains(hit.header, "Sec-WebSocket-Protocol: "+ed) {
		t.Fatalf("early data harus diklasifikasi dan diteruskan ke VLESS: %s\n%s", hit.name, hit.header)
	}
}

func TestRawSSHWithKey(t *testing.T) {
	defer setup(t)()
	h := newHarness(t, "101")
	defer h.close()
	c, r, resp := h.open(t, wsRequest("/ssh", ""))
	defer c.Close()
	expectAccept(t, resp)
	_, _ = c.Write([]byte("SSH-2.0-client\r\n"))
	hit := h.wait(t)
	if hit.name != "ssh" || !strings.HasPrefix(string(hit.data), "SSH-2.0-client") {
		t.Fatalf("SSH mentah setelah 101 harus ke SSH: %s %q", hit.name, hit.data)
	}
	line, _ := r.ReadString('\n')
	if line != "SSH-2.0-fake\r\n" {
		t.Fatalf("banner SSH harus sampai ke klien: %q", line)
	}
}

func TestSilentClientFallsBackToSSH(t *testing.T) {
	defer setup(t)()
	h := newHarness(t, "101")
	defer h.close()
	c, r, resp := h.open(t, wsRequest("/", ""))
	defer c.Close()
	expectAccept(t, resp)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	line, err := r.ReadString('\n')
	if err != nil || line != "SSH-2.0-fake\r\n" {
		t.Fatalf("klien yang menunggu banner harus disambungkan ke SSH: %q %v", line, err)
	}
	_, _ = c.Write([]byte("SSH-2.0-client\r\n"))
	if hit := h.wait(t); hit.name != "ssh" {
		t.Fatalf("seharusnya SSH, dapat %s", hit.name)
	}
}

func TestNoKeyKeepsOldSSHBehavior(t *testing.T) {
	defer setup(t)()
	h := newHarness(t, "101")
	defer h.close()
	c, _, resp := h.open(t, "GET /bebas HTTP/1.1\r\nHost: bug.com\r\nUpgrade: websocket\r\n\r\n")
	defer c.Close()
	if !strings.HasPrefix(resp, "HTTP/1.1 101") || strings.Contains(resp, "Sec-WebSocket-Accept") {
		t.Fatalf("payload SSH-WS tanpa key harus tetap dijawab seperti dulu:\n%s", resp)
	}
	_, _ = c.Write([]byte("SSH-2.0-client\r\n"))
	if hit := h.wait(t); hit.name != "ssh" {
		t.Fatalf("seharusnya SSH, dapat %s", hit.name)
	}
}

func TestMultipathDisabled(t *testing.T) {
	defer setup(t)()
	multipathEnabled = false
	h := newHarness(t, "101")
	defer h.close()
	c, _, resp := h.open(t, wsRequest("/bebas", ""))
	defer c.Close()
	if strings.Contains(resp, "Sec-WebSocket-Accept") {
		t.Fatalf("multipath mati harus memakai jalur lama:\n%s", resp)
	}
	_, _ = c.Write([]byte("SSH-2.0-client\r\n"))
	if hit := h.wait(t); hit.name != "ssh" {
		t.Fatalf("seharusnya SSH, dapat %s", hit.name)
	}
}

func realIPCase(t *testing.T, enabled bool) string {
	defer setup(t)()
	xrayRealIPEnabled = enabled
	h := newHarness(t, "101")
	defer h.close()
	c, _, _ := h.open(t, wsRequest("/bebas", "X-Forwarded-For: 6.6.6.6\r\nX-SC-SSHWS-IP: 203.0.113.5\r\nX-SC-Real-IP-Proxy: 1\r\n"))
	defer c.Close()
	_, _ = c.Write(maskedFrame(vmessLikePayload()))
	return h.wait(t).header
}

func TestRealIPHeaders(t *testing.T) {
	on := realIPCase(t, true)
	if !strings.Contains(on, "X-Forwarded-For: 203.0.113.5\r\n") || !strings.Contains(on, "X-SC-Real-IP-Proxy: 1\r\n") || strings.Contains(on, "6.6.6.6") {
		t.Fatalf("real IP aktif: Xray harus menerima IP asli dari nginx, bukan XFF klien:\n%s", on)
	}
	if strings.Contains(on, "X-SC-SSHWS-IP") {
		t.Fatalf("header internal tidak boleh diteruskan:\n%s", on)
	}
	off := realIPCase(t, false)
	if !strings.Contains(off, "X-Forwarded-For: 6.6.6.6\r\n") || strings.Contains(off, "X-SC-") {
		t.Fatalf("real IP mati: perilaku sama dengan location nginx (XFF klien lewat, header internal dibuang):\n%s", off)
	}
}

func TestBackendRejectClosesClient(t *testing.T) {
	defer setup(t)()
	h := newHarness(t, "404")
	defer h.close()
	c, r, _ := h.open(t, wsRequest("/bebas", ""))
	defer c.Close()
	_, _ = c.Write(maskedFrame(vmessLikePayload()))
	h.wait(t)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := r.ReadByte(); err == nil {
		t.Fatal("koneksi klien harus ditutup kalau Xray menolak")
	}
}

func TestUnmaskedFrameIsNotXray(t *testing.T) {
	defer setup(t)()
	h := newHarness(t, "101")
	defer h.close()
	c, _, _ := h.open(t, wsRequest("/bebas", ""))
	defer c.Close()
	_, _ = c.Write([]byte{0x82, 0x05, 'h', 'e', 'l', 'l', 'o'})
	if hit := h.wait(t); hit.name != "ssh" {
		t.Fatalf("data bukan frame klien harus tetap ke SSH, dapat %s", hit.name)
	}
}
