package main

import (
	"bytes"
	"fmt"
	"math/rand"
	"testing"

	"www.bamsoftware.com/git/dnstt.git/dns"
)

func scWireMessage(name dns.Name, kind uint16, opt bool, data []byte) *dns.Message {
	m := &dns.Message{
		ID: 0xbeef, Flags: 0x8580,
		Question: []dns.Question{{Name: name, Type: kind, Class: dns.ClassIN}},
		Answer:   []dns.RR{{Name: name, Type: kind, Class: dns.ClassIN, TTL: 60, Data: data}},
	}
	if opt {
		m.Additional = []dns.RR{{Type: dns.RRTypeOPT, Class: 1232, TTL: 0x01008000, Data: []byte{0, 12, 0, 2, 1, 2}}}
	}
	return m
}

func scWireNames() []dns.Name {
	return []dns.Name{
		{}, {[]byte("t"), []byte("example"), []byte("com")},
		{[]byte("MiXeD"), []byte("case")},
		{[]byte{0, '.', '\\', 255}, []byte("test")},
		{bytes.Repeat([]byte("a"), 63), bytes.Repeat([]byte("b"), 63), bytes.Repeat([]byte("c"), 63), bytes.Repeat([]byte("d"), 61)},
	}
}

func scAssertWireParity(t *testing.T, m *dns.Message) {
	t.Helper()
	want, wantErr := m.WireFormat()
	got, gotErr := scResponseWireFormat(m)
	if (wantErr == nil) != (gotErr == nil) || fmt.Sprint(wantErr) != fmt.Sprint(gotErr) {
		t.Fatalf("error berbeda: upstream=%v SC=%v", wantErr, gotErr)
	}
	if !bytes.Equal(want, got) {
		t.Fatalf("wire berbeda: upstream=%x SC=%x", want, got)
	}
}

func TestSCResponseWireParity(t *testing.T) {
	for _, name := range scWireNames() {
		for _, kind := range []uint16{dns.RRTypeTXT, rrTypeNULL} {
			for _, opt := range []bool{false, true} {
				for _, n := range []int{0, 1, 254, 255, 256, 510, 511, 1232, 4096, 65535, 65536} {
					data := bytes.Repeat([]byte{0xa5}, n)
					if kind == dns.RRTypeTXT {
						data = dns.EncodeRDataTXT(data)
					}
					m := scWireMessage(name, kind, opt, data)
					scAssertWireParity(t, m)
					if overhead, ok := scResponseOverhead(m); !ok || overhead+len(data) != scWireLength(m) {
						// Overflow RDATA tetap harus ditolak oleh serializer upstream.
						if len(data) <= 65535 {
							t.Fatalf("overhead salah: %d, %v", overhead, ok)
						}
					}
				}
			}
		}
	}
	// Label biner dan variasi flag/TTL/EDNS tidak boleh mengubah satu byte pun.
	rng := rand.New(rand.NewSource(121))
	for i := 0; i < 2500; i++ {
		var name dns.Name
		for labels := rng.Intn(4); labels > 0; labels-- {
			label := make([]byte, 1+rng.Intn(63))
			rng.Read(label)
			name = append(name, label)
		}
		kind := uint16(dns.RRTypeTXT)
		if i%2 == 0 {
			kind = rrTypeNULL
		}
		data := make([]byte, rng.Intn(4097))
		rng.Read(data)
		m := scWireMessage(name, kind, i%3 != 0, data)
		m.ID, m.Flags = uint16(rng.Intn(65536)), uint16(rng.Intn(65536))
		m.Question[0].Class = uint16(rng.Intn(65536))
		m.Answer[0].Class, m.Answer[0].TTL = uint16(rng.Intn(65536)), rng.Uint32()
		if len(m.Additional) != 0 {
			m.Additional[0].Class, m.Additional[0].TTL = uint16(rng.Intn(65536)), rng.Uint32()
		}
		scAssertWireParity(t, m)
	}
}

func scWireLength(m *dns.Message) int {
	wire, _ := m.WireFormat()
	return len(wire)
}

func TestSCResponseWireFallback(t *testing.T) {
	name := scWireNames()[1]
	for _, mutate := range []func(*dns.Message){
		func(m *dns.Message) { m.Question = nil },
		func(m *dns.Message) { m.Question = append(m.Question, m.Question[0]) },
		func(m *dns.Message) { m.Answer = nil },
		func(m *dns.Message) { m.Answer = append(m.Answer, m.Answer[0]) },
		func(m *dns.Message) { m.Answer[0].Name = dns.Name{[]byte("other")} },
		func(m *dns.Message) { m.Answer[0].Type = 1 },
		func(m *dns.Message) { m.Question[0].Type = rrTypeNULL },
		func(m *dns.Message) { m.Authority = []dns.RR{m.Answer[0]} },
		func(m *dns.Message) { m.Additional = append(m.Additional, m.Additional[0]) },
		func(m *dns.Message) { m.Additional[0].Name = name },
		func(m *dns.Message) { m.Additional[0].Type = 1 },
		func(m *dns.Message) { m.Additional[0].Data = make([]byte, 65536) },
	} {
		m := scWireMessage(name, dns.RRTypeTXT, true, []byte{1, 65})
		mutate(m)
		if _, ok := scResponseOverhead(m); ok {
			t.Fatal("bentuk nonstandar wajib memakai fallback")
		}
		scAssertWireParity(t, m)
	}
}

// Oracle V.120/sc-fast4: ukuran overhead melalui serializer upstream.
func scOldMaxPayload(resp *dns.Message, sizeCap int) int {
	if len(resp.Answer) == 0 {
		return 0
	}
	saved := resp.Answer[0].Data
	defer func() { resp.Answer[0].Data = saved }()
	resp.Answer[0].Data = nil
	wire, err := resp.WireFormat()
	if err != nil || sizeCap <= len(wire) {
		return 0
	}
	avail := sizeCap - len(wire)
	if resp.Answer[0].Type == rrTypeNULL {
		return avail
	}
	for avail+(avail+254)/255 > sizeCap-len(wire) {
		avail--
	}
	return avail
}

func TestSCMaxPayloadParity(t *testing.T) {
	for _, name := range scWireNames() {
		for _, kind := range []uint16{dns.RRTypeTXT, rrTypeNULL} {
			for _, opt := range []bool{false, true} {
				m := scWireMessage(name, kind, opt, []byte{1, 65})
				for cap := -1; cap <= 4096; cap++ {
					want := scOldMaxPayload(m, cap)
					if got := maxPayloadForResponse(m, cap); got != want {
						t.Fatalf("payload berubah: kind=%d cap=%d got=%d want=%d", kind, cap, got, want)
					}
					if !bytes.Equal(m.Answer[0].Data, []byte{1, 65}) {
						t.Fatal("data respons berubah setelah perhitungan")
					}
				}
			}
		}
	}
	// Fallback juga harus mempertahankan ukuran respons nonstandar.
	m := scWireMessage(scWireNames()[1], dns.RRTypeTXT, true, []byte{1, 65})
	m.Authority = []dns.RR{m.Answer[0]}
	if got, want := maxPayloadForResponse(m, 1232), scOldMaxPayload(m, 1232); got != want {
		t.Fatalf("fallback payload berubah: %d != %d", got, want)
	}
}

var scWireSink []byte
var scSizeSink int

func TestSCResponseAllocationBudget(t *testing.T) {
	for _, kind := range []uint16{dns.RRTypeTXT, rrTypeNULL} {
		m := scWireMessage(scWireNames()[1], kind, true, bytes.Repeat([]byte{65}, 1024))
		if allocs := testing.AllocsPerRun(100, func() {
			scSizeSink = maxPayloadForResponse(m, 1232)
		}); allocs != 0 {
			t.Fatalf("hitung kapasitas harus tanpa alokasi, got %.1f", allocs)
		}
		if allocs := testing.AllocsPerRun(100, func() {
			scWireSink, _ = scResponseWireFormat(m)
		}); allocs > 1 {
			t.Fatalf("encoder normal maksimal satu buffer, got %.1f", allocs)
		}
	}
}

func BenchmarkSCResponse(b *testing.B) {
	for _, kind := range []uint16{dns.RRTypeTXT, rrTypeNULL} {
		name := dns.Name{bytes.Repeat([]byte("a"), 63), bytes.Repeat([]byte("b"), 63), []byte("t"), []byte("example"), []byte("com")}
		data := bytes.Repeat([]byte{65}, 1024)
		if kind == dns.RRTypeTXT {
			data = dns.EncodeRDataTXT(data)
		}
		for _, old := range []bool{true, false} {
			version := "sc-fast5"
			if old {
				version = "sc-fast4"
			}
			b.Run(fmt.Sprintf("type%d/%s", kind, version), func(b *testing.B) {
				m := scWireMessage(name, kind, true, data)
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if old {
						scSizeSink = scOldMaxPayload(m, 1232)
						scWireSink, _ = m.WireFormat()
					} else {
						scSizeSink = maxPayloadForResponse(m, 1232)
						scWireSink, _ = scResponseWireFormat(m)
					}
				}
			})
		}
	}
}
