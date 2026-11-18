package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"io/ioutil"
	"net"
	"strings"
	"testing"
	"time"
)

func shimTestListen(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return listener
}

func shimTestDial(t *testing.T, address string) *net.TCPConn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
	return conn.(*net.TCPConn)
}

func shimTestStart(t *testing.T, routes map[string]string, limit int) (net.Listener, chan error) {
	t.Helper()
	listener := shimTestListen(t)
	done := make(chan error, 1)
	go func() { done <- shimServe(listener, routes, limit) }()
	return listener, done
}

func shimTestRequest(path string) string {
	return "GET " + path + "?ed=2048 HTTP/1.1\r\nHost: vpn.example.com\r\n" +
		"Connection: keep-alive, Upgrade\r\nUpgrade: WebSocket\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
		"X-Forwarded-For: 198.51.100.7\r\nX-SC-Real-IP-Proxy: 1\r\n" +
		"Content-Length: 0\r\n\r\n"
}

const shimTestResponse = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
	"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"

func TestShimRawStreams(t *testing.T) {
	payload := append([]byte{0, 255, 128, 1, 10, 13}, []byte("binary\r\nHTTP/ 69\r\n\r\ninside")...)
	for _, route := range []string{"/upvmess", "/upvless", "/uptrojan"} {
		for _, mode := range []string{"coalesced", "fragmented", "plain", "partial-prefix", "partial-eof", "double-marker"} {
			t.Run(route+"/"+mode, func(t *testing.T) {
				backend := shimTestListen(t)
				defer backend.Close()
				result := make(chan error, 1)
				expected := payload
				switch mode {
				case "partial-prefix":
					expected = append([]byte("HTTP/ 68\r\n\r\n"), payload...)
				case "partial-eof":
					expected = []byte("HTTP/")
				case "double-marker":
					expected = append([]byte(shimMagic), payload...)
				}
				go func() {
					conn, err := backend.Accept()
					if err != nil {
						result <- err
						return
					}
					defer conn.Close()
					_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
					reader := bufio.NewReader(conn)
					headers, err := shimReadHeaders(reader)
					if err != nil {
						result <- err
						return
					}
					for _, want := range []string{
						"GET " + route + " HTTP/1.1\r\n", "Host: vpn.example.com\r\n",
						"Connection: Upgrade\r\n", "Upgrade: websocket\r\n",
						"Sec-Websocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n", "Sec-Websocket-Version: 13\r\n",
						"X-Forwarded-For: 198.51.100.7\r\n", "X-Sc-Real-Ip-Proxy: 1\r\n",
					} {
						if !bytes.Contains(headers, []byte(want)) {
							result <- fmt.Errorf("upstream missing %q: %s", want, headers)
							return
						}
					}
					// A server-first payload must reach the client before it uploads.
					_, _ = io.WriteString(conn, shimTestResponse+"server-first")
					got, err := ioutil.ReadAll(reader)
					if err != nil || !bytes.Equal(got, expected) {
						result <- fmt.Errorf("raw stream %x, want %x (err %v)", got, expected, err)
						return
					}
					// Sent after upload EOF: exercise TCP half-close in both directions.
					_, err = conn.Write(append([]byte("reply:"), got...))
					result <- err
				}()
				listener, done := shimTestStart(t, map[string]string{route: backend.Addr().String()}, 256)
				defer func() { listener.Close(); <-done }()
				client := shimTestDial(t, listener.Addr().String())
				defer client.Close()
				initial := []byte(shimTestRequest(route))
				if mode == "coalesced" || mode == "double-marker" {
					initial = append(initial, []byte(shimMagic)...)
					initial = append(initial, expected...)
				}
				_, _ = client.Write(initial)
				reader := bufio.NewReader(client)
				headers, err := shimReadHeaders(reader)
				if err != nil || string(headers) != shimTestResponse {
					t.Fatalf("response %q (%v)", headers, err)
				}
				first := make([]byte, len("server-first"))
				if _, err := io.ReadFull(reader, first); err != nil || string(first) != "server-first" {
					t.Fatalf("server-first data %q (%v)", first, err)
				}
				if mode == "fragmented" {
					for _, value := range []byte(shimMagic) {
						_, _ = client.Write([]byte{value})
						time.Sleep(time.Millisecond)
					}
				}
				if mode != "coalesced" && mode != "double-marker" {
					_, _ = client.Write(expected)
				}
				_ = client.CloseWrite()
				reply, err := ioutil.ReadAll(reader)
				if err != nil || !bytes.Equal(reply, append([]byte("reply:"), expected...)) {
					t.Fatalf("reply %x (%v)", reply, err)
				}
				if err := <-result; err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestShimHeaderLimitAndRemainder(t *testing.T) {
	for _, length := range []int{shimHeaderLimit - 4, shimHeaderLimit - 3} {
		input := strings.Repeat("a", length) + "\r\n\r\n" + "raw-data"
		reader := bufio.NewReaderSize(strings.NewReader(input), 512)
		headers, err := shimReadHeaders(reader)
		if length+4 > shimHeaderLimit {
			if err == nil {
				t.Fatal("oversize header accepted")
			}
			continue
		}
		if err != nil || len(headers) != shimHeaderLimit {
			t.Fatalf("header boundary rejected: %v", err)
		}
		remainder, _ := ioutil.ReadAll(reader)
		if string(remainder) != "raw-data" {
			t.Fatalf("remainder lost: %q", remainder)
		}
	}
}

func TestShimRejectsBadRequests(t *testing.T) {
	listener, done := shimTestStart(t, shimRoutes, 256)
	defer func() { listener.Close(); <-done }()
	for _, tc := range []struct{ request, status string }{
		{shimTestRequest("/vmess"), "404 Not Found"},
		{strings.Replace(shimTestRequest("/upvless"), "GET ", "POST ", 1), "400 Bad Request"},
		{strings.Replace(shimTestRequest("/uptrojan"), "Upgrade: WebSocket", "Upgrade: invalid", 1), "400 Bad Request"},
	} {
		client := shimTestDial(t, listener.Addr().String())
		_, _ = io.WriteString(client, tc.request)
		reply, err := ioutil.ReadAll(client)
		client.Close()
		if err != nil || !bytes.Contains(reply, []byte(tc.status)) {
			t.Fatalf("bad request response %q (%v)", reply, err)
		}
	}
}

func TestShimBackendRefusalAndSlotRelease(t *testing.T) {
	backend := shimTestListen(t)
	defer backend.Close()
	accepted := make(chan struct{})
	release := make(chan struct{})
	backendDone := make(chan struct{})
	go func() {
		defer close(backendDone)
		conn, err := backend.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
		_, _ = shimReadHeaders(bufio.NewReader(conn))
		close(accepted)
		<-release
		_, _ = io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\n\r\ndenied")
	}()
	listener, done := shimTestStart(t, map[string]string{"/upvmess": backend.Addr().String()}, 1)
	defer func() { listener.Close(); <-done }()
	first := shimTestDial(t, listener.Addr().String())
	defer first.Close()
	_, _ = io.WriteString(first, shimTestRequest("/upvmess"))
	select {
	case <-accepted:
	case <-time.After(4 * time.Second):
		t.Fatal("backend not reached")
	}
	second := shimTestDial(t, listener.Addr().String())
	var b [1]byte
	if n, err := second.Read(b[:]); n != 0 || err == nil {
		t.Fatal("connection limit did not reject excess client")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("excess client was left waiting")
	}
	second.Close()
	close(release)
	reply, err := ioutil.ReadAll(first)
	if err != nil || !bytes.Contains(reply, []byte("403 Forbidden")) || !bytes.HasSuffix(reply, []byte("denied")) {
		t.Fatalf("upstream rejection lost: %q (%v)", reply, err)
	}
	<-backendDone
	// A rejected setup releases its slot for a subsequent request.
	third := shimTestDial(t, listener.Addr().String())
	defer third.Close()
	_, _ = io.WriteString(third, shimTestRequest("/unknown"))
	reply, err = ioutil.ReadAll(third)
	if err != nil || !bytes.Contains(reply, []byte("404 Not Found")) {
		t.Fatalf("slot not released: %q (%v)", reply, err)
	}
}
