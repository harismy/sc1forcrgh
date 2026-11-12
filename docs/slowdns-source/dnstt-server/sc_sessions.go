package main

import (
    "bytes"
    "fmt"
    "io"
    "log"
    "net"
    "os"
    "sync"
    "sync/atomic"
    "time"
)

// Satu ClientID dapat memiliki banyak stream SSH; penghitung tunnel melakukan
// deduplikasi ClientID setelah username dibuktikan oleh tracker autentikasi SSH.
type scSession struct {
    up uint64
    down uint64
    ended int64
    port int
    clientID string
    started int64
}

var scSessionsMu sync.Mutex
var scSessions = make(map[int]*scSession)
var scMonitorEnabled bool
var scMonitorStarted = time.Now().UnixNano()

func scTrackStream(conn *net.TCPConn, clientID string) *scSession {
    if !scMonitorEnabled || len(clientID) != 16 { return nil }
    addr, ok := conn.LocalAddr().(*net.TCPAddr)
    if !ok { return nil }
    s := &scSession{port: addr.Port, clientID: clientID, started: time.Now().UnixNano()}
    scSessionsMu.Lock()
    scSessions[s.port] = s
    scSessionsMu.Unlock()
    return s
}

// Stream yang sudah putus disimpan sebentar beserta penghitung akhirnya.
const (
    scEndedKeepNanos = int64(30 * time.Minute)
    scEndedMax = 4096
)

var scEnded []*scSession

func scPruneEndedLocked(now int64) {
    drop := 0
    for drop < len(scEnded) && (now-scEnded[drop].ended > scEndedKeepNanos || len(scEnded)-drop > scEndedMax) {
        drop++
    }
    if drop > 0 {
        n := copy(scEnded, scEnded[drop:])
        for i := n; i < len(scEnded); i++ { scEnded[i] = nil }
        scEnded = scEnded[:n]
    }
}

func scUntrackStream(s *scSession) {
    if s == nil { return }
    now := time.Now().UnixNano()
    scSessionsMu.Lock()
    if scSessions[s.port] == s { delete(scSessions, s.port) }
    s.ended = now
    scEnded = append(scEnded, s)
    scPruneEndedLocked(now)
    scSessionsMu.Unlock()
}

// Byte dari Dropbear ke klien (download), untuk kuota.
type scDownWriter struct { io.Writer; session *scSession }
func (w scDownWriter) Write(p []byte) (int, error) {
    n, err := w.Writer.Write(p)
    if n > 0 { atomic.AddUint64(&w.session.down, uint64(n)) }
    return n, err
}

func scStreamWriter(stream io.Writer, s *scSession) io.Writer {
    if s == nil { return stream }
    return scDownWriter{stream, s}
}

type scCountingWriter struct { io.Writer; session *scSession }
func (w scCountingWriter) Write(p []byte) (int, error) {
    n, err := w.Writer.Write(p)
    if n > 0 { atomic.AddUint64(&w.session.up, uint64(n)) }
    return n, err
}

func scSessionWriter(conn *net.TCPConn, s *scSession) io.Writer {
    if s == nil { return conn }
    return scCountingWriter{conn, s}
}

func scSessionSnapshot() []byte {
    var b bytes.Buffer
    fmt.Fprintf(&b, "SC_SLOWDNS_SESSIONS_V2|%d|%d\n", os.Getpid(), scMonitorStarted)
    scSessionsMu.Lock()
    for _, s := range scSessions {
        fmt.Fprintf(&b, "%d|%s|%d|%d|%d\n", s.port, s.clientID, atomic.LoadUint64(&s.up), s.started, atomic.LoadUint64(&s.down))
    }
    scPruneEndedLocked(time.Now().UnixNano())
    for _, s := range scEnded {
        fmt.Fprintf(&b, "E|%d|%s|%d|%d|%d|%d\n", s.port, s.clientID, atomic.LoadUint64(&s.up), s.started, atomic.LoadUint64(&s.down), s.ended)
    }
    scSessionsMu.Unlock()
    b.WriteString("END\n")
    return b.Bytes()
}

func scStartSessionMonitor() func() {
    path := os.Getenv("SLOWDNS_SESSION_SOCKET")
    if path == "" { return func() {} }
    if st, err := os.Lstat(path); err == nil {
        if st.Mode()&os.ModeSocket == 0 {
            log.Printf("SlowDNS monitor: path bukan socket")
            return func() {}
        }
        if err := os.Remove(path); err != nil { return func() {} }
    }
    ln, err := net.Listen("unix", path)
    if err != nil {
        log.Printf("SlowDNS monitor tidak tersedia: %v", err)
        return func() {}
    }
    if err := os.Chmod(path, 0600); err != nil {
        ln.Close()
        os.Remove(path)
        return func() {}
    }
    scMonitorEnabled = true
    go func() {
        for {
            conn, err := ln.Accept()
            if err != nil { return }
            conn.SetWriteDeadline(time.Now().Add(time.Second))
            conn.Write(scSessionSnapshot())
            conn.Close()
        }
    }()
    return func() { ln.Close(); os.Remove(path) }
}

func scReadSessionMonitor(path string) error {
    conn, err := net.DialTimeout("unix", path, time.Second)
    if err != nil { return err }
    defer conn.Close()
    conn.SetReadDeadline(time.Now().Add(time.Second))
    _, err = io.Copy(os.Stdout, io.LimitReader(conn, 1<<20))
    return err
}
