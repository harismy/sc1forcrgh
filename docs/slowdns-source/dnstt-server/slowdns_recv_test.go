package main

import (
	"bytes"
	"io"
	"net"
	"runtime"
	"testing"
	"time"

	"www.bamsoftware.com/git/dnstt.git/dns"
	"www.bamsoftware.com/git/dnstt.git/turbotunnel"
)

type scRecvConn struct {
	net.PacketConn
	packets [][]byte
	count   int
	limit   int
}

var scRecvAddr = &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 12345}

func (c *scRecvConn) ReadFrom(buf []byte) (int, net.Addr, error) {
	if c.count == c.limit {
		return 0, nil, io.EOF
	}
	packet := c.packets[c.count%len(c.packets)]
	c.count++
	return copy(buf, packet), scRecvAddr, nil
}

func scRecvQuery(tb testing.TB, kind uint16, payload []byte) ([]byte, dns.Name, turbotunnel.ClientID) {
	tb.Helper()
	domain, _ := dns.ParseName("t.local.test")
	var cid turbotunnel.ClientID
	for i := range cid {
		cid[i] = 65
	}
	raw := append([]byte(nil), cid[:]...)
	if payload == nil {
		raw = append(raw, 0xe0, 0xe0, 0xe0, 0xe0) // query poll tanpa paket KCP
	} else {
		raw = append(raw, byte(len(payload)))
		raw = append(raw, payload...)
	}
	encoded := []byte(base32Encoding.EncodeToString(raw))
	var labels [][]byte
	for len(encoded) > 0 {
		n := 63
		if len(encoded) < n {
			n = len(encoded)
		}
		labels = append(labels, encoded[:n])
		encoded = encoded[n:]
	}
	labels = append(labels, domain...)
	name, err := dns.NewName(labels)
	if err != nil {
		tb.Fatal(err)
	}
	query := dns.Message{ID: 42, Question: []dns.Question{{Name: name, Type: kind, Class: dns.ClassIN}},
		Additional: []dns.RR{{Type: dns.RRTypeOPT, Class: 1232}}}
	wire, err := query.WireFormat()
	if err != nil {
		tb.Fatal(err)
	}
	return wire, name, cid
}

func TestSCRecvBufferOwnership(t *testing.T) {
	domain, _ := dns.ParseName("t.local.test")
	for _, kind := range []uint16{dns.RRTypeTXT, rrTypeNULL} {
		first, second := bytes.Repeat([]byte{65}, 96), []byte("two")
		wire1, name1, cid := scRecvQuery(t, kind, first)
		wire2, name2, _ := scRecvQuery(t, kind, second)
		defer clientEdnsForget(cid)
		tt := turbotunnel.NewQueuePacketConn(turbotunnel.DummyAddr{}, time.Minute)
		defer tt.Close()
		records := make(chan *record, 2)
		conn := &scRecvConn{packets: [][]byte{wire1, wire2}, limit: 2}
		if err := recvLoop(domain, conn, tt, records); err != io.EOF {
			t.Fatal(err)
		}
		if len(records) != 2 {
			t.Fatal("respons hilang saat buffer dipakai ulang")
		}
		for _, name := range []dns.Name{name1, name2} {
			r := <-records
			if r.Resp.Question[0].Name.String() != name.String() || r.ClientID != cid || r.Size != 1232 {
				t.Fatal("record tertunda berubah setelah paket berikutnya menimpa buffer")
			}
		}
		done := make(chan [][]byte, 1)
		go func() {
			var got [][]byte
			for i := 0; i < 2; i++ {
				buf := make([]byte, 256)
				n, _, err := tt.ReadFrom(buf)
				if err != nil {
					break
				}
				got = append(got, buf[:n])
			}
			done <- got
		}()
		select {
		case got := <-done:
			if len(got) != 2 || !bytes.Equal(got[0], first) || !bytes.Equal(got[1], second) {
				t.Fatal("paket KCP meminjam buffer query yang sudah ditimpa")
			}
		case <-time.After(time.Second):
			t.Fatal("timeout membaca paket KCP")
		}
	}
}

func TestSCRecvAllocationBudget(t *testing.T) {
	domain, _ := dns.ParseName("t.local.test")
	wire, _, cid := scRecvQuery(t, rrTypeNULL, nil)
	defer clientEdnsForget(cid)
	const count = 512
	conn := &scRecvConn{packets: [][]byte{wire}, limit: count}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if err := recvLoop(domain, conn, nil, nil); err != io.EOF {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if perQuery := (after.TotalAlloc - before.TotalAlloc) / count; perQuery > 2048 {
		t.Fatalf("alokasi query poll terlalu besar: %d B/query (buffer 4096 byte tidak boleh dibuat per paket)", perQuery)
	}
}

func BenchmarkSCRecvLoop(b *testing.B) {
	domain, _ := dns.ParseName("t.local.test")
	wire, _, cid := scRecvQuery(b, rrTypeNULL, nil)
	defer clientEdnsForget(cid)
	conn := &scRecvConn{packets: [][]byte{wire}, limit: b.N}
	b.ReportAllocs()
	b.ResetTimer()
	if err := recvLoop(domain, conn, nil, nil); err != io.EOF {
		b.Fatal(err)
	}
}
