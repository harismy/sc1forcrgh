package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func scTestState(t *testing.T) {
	t.Helper()
	scMonitorEnabled = true
	scSessionsMu.Lock()
	scSessions = make(map[int]*scSession)
	scSessionsMu.Unlock()
	t.Cleanup(func() { scMonitorEnabled = false })
}

func scTestTCP(t *testing.T) (*net.TCPConn, net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); server.Close() })
	return client.(*net.TCPConn), server
}

func TestSCTracksClientBytesAndStreamLifecycle(t *testing.T) {
	scTestState(t)
	conn, peer := scTestTCP(t)
	s := scTrackStream(conn, "aaaaaaaaaaaaaaaa")
	if s == nil {
		t.Fatal("stream tidak tercatat")
	}
	if _, err := scSessionWriter(conn, s).Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(peer, buf); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadUint64(&s.up) != 5 {
		t.Fatal("trafik klien salah")
	}
	if _, err := peer.Write([]byte("download")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(conn, make([]byte, 8)); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadUint64(&s.up) != 5 {
		t.Fatal("trafik server ikut menambah bukti aktivitas klien")
	}
	snapshot := string(scSessionSnapshot())
	if !strings.Contains(snapshot, fmt.Sprintf("%d|aaaaaaaaaaaaaaaa|5|", s.port)) || !strings.HasSuffix(snapshot, "END\n") {
		t.Fatal(snapshot)
	}
	scUntrackStream(s)
	if strings.Contains(string(scSessionSnapshot()), "aaaaaaaaaaaaaaaa") {
		t.Fatal("stream putus masih muncul")
	}
	if scSessionWriter(conn, nil) != conn {
		t.Fatal("mode tanpa monitor harus memakai koneksi asli")
	}
}

func TestSCMultipleStreamsShareClientIDAndDoNotDeleteReusedPorts(t *testing.T) {
	scTestState(t)
	a, _ := scTestTCP(t)
	b, _ := scTestTCP(t)
	x := scTrackStream(a, "bbbbbbbbbbbbbbbb")
	y := scTrackStream(b, "bbbbbbbbbbbbbbbb")
	if strings.Count(string(scSessionSnapshot()), "bbbbbbbbbbbbbbbb") != 2 {
		t.Fatal("dua stream kehilangan ClientID asli")
	}
	fresh := &scSession{port: x.port, clientID: "cccccccccccccccc", started: x.started + 1}
	scSessionsMu.Lock()
	scSessions[x.port] = fresh
	scSessionsMu.Unlock()
	scUntrackStream(x)
	if !strings.Contains(string(scSessionSnapshot()), "cccccccccccccccc") {
		t.Fatal("cleanup stream lama menghapus pemilik port baru")
	}
	scUntrackStream(y)
	if strings.Contains(string(scSessionSnapshot()), "bbbbbbbbbbbbbbbb") {
		t.Fatal("stream sudah ditutup")
	}
}

func TestSCUnixMonitorSnapshot(t *testing.T) {
	scTestState(t)
	scMonitorEnabled = false
	socket := filepath.Join(t.TempDir(), "sc.sock")
	t.Setenv("SLOWDNS_SESSION_SOCKET", socket)
	stop := scStartSessionMonitor()
	defer stop()
	if !scMonitorEnabled {
		t.Skip("Unix socket tidak tersedia pada host pengujian")
	}
	conn, _ := scTestTCP(t)
	s := scTrackStream(conn, "dddddddddddddddd")
	defer scUntrackStream(s)
	query, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer query.Close()
	data, err := io.ReadAll(query)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(data), fmt.Sprintf("SC_SLOWDNS_SESSIONS_V1|%d|", os.Getpid())) || !strings.Contains(string(data), "dddddddddddddddd") {
		t.Fatal(string(data))
	}
}

func TestSCMonitorPreservesNonSocketFiles(t *testing.T) {
	scMonitorEnabled = false
	file := filepath.Join(t.TempDir(), "regular-file")
	if err := os.WriteFile(file, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SLOWDNS_SESSION_SOCKET", file)
	stop := scStartSessionMonitor()
	defer stop()
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "keep" || scMonitorEnabled {
		t.Fatal("monitor merusak file yang bukan socket")
	}
}

func BenchmarkSCClientByteCounter(b *testing.B) {
	w := scCountingWriter{Writer: io.Discard, session: &scSession{}}
	p := make([]byte, 16384)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w.Write(p)
	}
}
