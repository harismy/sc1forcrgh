package dns

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func TestTunnelRecords(t *testing.T) {
	name, _ := ParseName("abcd.test.example")
	domain, _ := ParseName("test.example")
	for _, kind := range []uint16{1, 2, 5, 10, 15, 16, 28, 33} {
		for _, cap := range []int{512, 1232, 4096} {
			n := TunnelCapacity(kind, cap, 255)
			for _, size := range []int{0, 1, 24, n} {
				payload := bytes.Repeat([]byte{0x43}, size)
				q := Question{Name: name, Type: kind, Class: ClassIN}
				answers, err := TunnelAnswers(q, 0, payload)
				if err != nil {
					t.Fatal(kind, size, err)
				}
				// Recursive resolvers may reorder RRsets.
				for i, j := 0, len(answers)-1; i < j; i, j = i+1, j-1 {
					answers[i], answers[j] = answers[j], answers[i]
				}
				m := Message{Flags: 0x8400, Question: []Question{q}, Answer: answers, Additional: []RR{{Type: RRTypeOPT, Class: 1232}}}
				wire, err := m.WireFormat()
				if err != nil {
					t.Fatal(err)
				}
				if len(wire) > cap {
					t.Fatalf("type %d payload %d exceeds cap %d: %d", kind, size, cap, len(wire))
				}
				got, err := DecodeTunnelResponse(wire, domain, kind)
				if err != nil || !bytes.Equal(got, payload) {
					t.Fatalf("type %d size %d: %v", kind, size, err)
				}
				if _, err = DecodeTunnelResponse(wire[:len(wire)-1], domain, kind); err == nil {
					t.Fatal("accepted truncation")
				}
			}
		}
	}
}

func TestTunnelCompressedRdata(t *testing.T) {
	name, _ := ParseName("dnstt.invalid")
	domain, _ := ParseName("invalid")
	for _, kind := range []uint16{2, 5, 15, 33} {
		payload := []byte("compressed response through recursive resolver")
		q := Question{Name: name, Type: kind, Class: ClassIN}
		answer, _ := TunnelAnswers(q, 0, payload)
		m := Message{Flags: 0x8400, Question: []Question{q}, Answer: answer}
		wire, _ := m.WireFormat()
		r := bytes.NewReader(wire)
		r.Seek(12, io.SeekStart)
		readQuestion(r)
		rr, err := readRR(r)
		if err != nil {
			t.Fatal(err)
		}
		end, _ := r.Seek(0, io.SeekCurrent)
		dataStart := int(end) - len(rr.Data)
		compressed := append([]byte(nil), wire[:int(end)-15]...)
		compressed = append(compressed, 0xc0, 0x0c)
		binary.BigEndian.PutUint16(compressed[dataStart-2:], uint16(len(rr.Data)-13))
		got, err := DecodeTunnelResponse(compressed, domain, kind)
		if err != nil || !bytes.Equal(got, payload) {
			t.Fatal(kind, err)
		}
	}
}

func TestTunnelMissingAddressFragment(t *testing.T) {
	name, _ := ParseName("abc.test.example")
	domain, _ := ParseName("test.example")
	for _, kind := range []uint16{1, 28} {
		q := Question{Name: name, Type: kind, Class: ClassIN}
		answer, _ := TunnelAnswers(q, 0, bytes.Repeat([]byte("a"), 60))
		answer = append(answer[:1], answer[2:]...)
		m := Message{Flags: 0x8400, Question: []Question{q}, Answer: answer}
		wire, _ := m.WireFormat()
		if _, err := DecodeTunnelResponse(wire, domain, kind); err == nil {
			t.Fatal("accepted missing fragment", kind)
		}
	}
}
