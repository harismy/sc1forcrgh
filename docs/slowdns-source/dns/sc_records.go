package dns

// Shared by the Android client and AutoSC server. TXT/NULL retain upstream wire compatibility.
import (
	"bytes"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"io"
	"strings"
)

var tunnelEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)
var tunnelSuffix = Name{[]byte("dnstt"), []byte("invalid")}
var errTunnelRecord = errors.New("invalid tunnel DNS record")

func TunnelType(t uint16) bool {
	switch t {
	case 1, 2, 5, 10, 15, 16, 28, 33:
		return true
	}
	return false
}

// TunnelCapacity includes the two-byte packet prefixes carried inside the payload.
// nameLen is the uncompressed question name length, including the root label.
func TunnelCapacity(t uint16, size, nameLen int) int {
	base := 12 + nameLen + 4 + 11 // header, question, OPT
	avail := size - base - 12     // one answer header with compressed owner name
	if avail < 0 {
		return 0
	}
	switch t {
	case 10:
		return avail
	case 16:
		n := avail
		for n > 0 && n+(n+254)/255 > avail {
			n--
		}
		return n
	case 1, 28:
		unit, chunk := 16, 3
		if t == 28 {
			unit, chunk = 28, 15
		}
		count := (size - base) / unit
		if count > 256 {
			count = 256
		}
		if count < 1 {
			return 0
		}
		return count*chunk - 2
	case 2, 5, 15, 33:
		prefix := 0
		if t == 15 {
			prefix = 2
		}
		if t == 33 {
			prefix = 6
		}
		avail -= prefix
		if avail > 255 {
			avail = 255
		}
		// The suffix occupies 15 octets. Each data label adds a length octet.
		for n := 147; n >= 0; n-- {
			chars := tunnelEncoding.EncodedLen(n)
			labels := (chars + 62) / 63
			if chars+labels+15 <= avail {
				return n
			}
		}
	}
	return 0
}

func TunnelAnswers(q Question, ttl uint32, payload []byte) ([]RR, error) {
	rr := RR{Name: q.Name, Type: q.Type, Class: q.Class, TTL: ttl}
	switch q.Type {
	case 16:
		rr.Data = EncodeRDataTXT(payload)
	case 10:
		rr.Data = append([]byte(nil), payload...)
	case 2, 5, 15, 33:
		encoded := strings.ToLower(tunnelEncoding.EncodeToString(payload))
		labels := Name{}
		for len(encoded) > 0 {
			n := len(encoded)
			if n > 63 {
				n = 63
			}
			labels = append(labels, []byte(encoded[:n]))
			encoded = encoded[n:]
		}
		labels = append(labels, tunnelSuffix...)
		if _, err := NewName(labels); err != nil {
			return nil, err
		}
		prefix := 0
		if q.Type == 15 {
			prefix = 2
		}
		if q.Type == 33 {
			prefix = 6
		}
		rr.Data = make([]byte, prefix)
		for _, label := range labels {
			rr.Data = append(rr.Data, byte(len(label)))
			rr.Data = append(rr.Data, label...)
		}
		rr.Data = append(rr.Data, 0)
	case 1, 28:
		width := 4
		if q.Type == 28 {
			width = 16
		}
		chunk := width - 1
		if len(payload)+2 > 256*chunk {
			return nil, errTunnelRecord
		}
		framed := make([]byte, 2+len(payload))
		binary.BigEndian.PutUint16(framed, uint16(len(payload)))
		copy(framed[2:], payload)
		result := make([]RR, 0, (len(framed)+chunk-1)/chunk)
		for i, off := 0, 0; off < len(framed); i, off = i+1, off+chunk {
			part := rr
			part.Data = make([]byte, width)
			part.Data[0] = byte(i)
			copy(part.Data[1:], framed[off:])
			result = append(result, part)
		}
		return result, nil
	default:
		return nil, errTunnelRecord
	}
	return []RR{rr}, nil
}

// DecodeTunnelResponse resolves compressed RDATA names against the original message,
// rather than interpreting a copied RDATA slice as an independent DNS packet.
func DecodeTunnelResponse(wire []byte, domain Name, kind uint16) ([]byte, error) {
	msg, err := MessageFromWireFormat(wire)
	if err != nil {
		return nil, err
	}
	if msg.Flags&0x820f != 0x8000 || len(msg.Question) != 1 || msg.Question[0].Type != kind {
		return nil, errTunnelRecord
	}
	if _, ok := msg.Question[0].Name.TrimSuffix(domain); !ok {
		return nil, errTunnelRecord
	}
	// Preserve the one-parse fast path for the default TXT/NULL transports.
	if kind == 16 || kind == 10 {
		if len(msg.Answer) != 1 {
			return nil, errTunnelRecord
		}
		rr := msg.Answer[0]
		if rr.Type != kind || rr.Class != ClassIN || !tunnelNameEqual(rr.Name, msg.Question[0].Name) {
			return nil, errTunnelRecord
		}
		if kind == 10 {
			return rr.Data, nil
		}
		return DecodeRDataTXT(rr.Data)
	}
	var r *bytes.Reader
	if kind != 1 && kind != 28 {
		r = bytes.NewReader(wire)
		r.Seek(12, io.SeekStart)
		if _, err = readQuestion(r); err != nil {
			return nil, err
		}
	}
	var single []byte
	found := false
	parts := make(map[int][]byte)
	width := 4
	if kind == 28 {
		width = 16
	}
	for _, answer := range msg.Answer {
		rr := answer
		var end int64
		if r != nil {
			rr, err = readRR(r)
			if err != nil {
				return nil, err
			}
			end, _ = r.Seek(0, io.SeekCurrent)
		}
		if rr.Type != kind || rr.Class != ClassIN || !tunnelNameEqual(rr.Name, msg.Question[0].Name) {
			continue
		}
		switch kind {
		case 1, 28:
			if len(rr.Data) != width {
				return nil, errTunnelRecord
			}
			index := int(rr.Data[0])
			part := rr.Data[1:]
			if old, ok := parts[index]; ok && !bytes.Equal(old, part) {
				return nil, errTunnelRecord
			}
			parts[index] = part
		case 16, 10, 2, 5, 15, 33:
			if found {
				return nil, errTunnelRecord
			}
			found = true
			switch kind {
			case 16:
				single, err = DecodeRDataTXT(rr.Data)
			case 10:
				single = rr.Data
			default:
				prefix := 0
				if kind == 15 {
					prefix = 2
				}
				if kind == 33 {
					prefix = 6
				}
				if len(rr.Data) < prefix+1 {
					return nil, errTunnelRecord
				}
				nr := bytes.NewReader(wire)
				nr.Seek(end-int64(len(rr.Data))+int64(prefix), io.SeekStart)
				name, e := readName(nr)
				if e != nil {
					return nil, e
				}
				pos, _ := nr.Seek(0, io.SeekCurrent)
				if pos != end {
					return nil, errTunnelRecord
				}
				labels, ok := name.TrimSuffix(tunnelSuffix)
				if !ok {
					return nil, errTunnelRecord
				}
				single, err = tunnelEncoding.DecodeString(strings.ToUpper(string(bytes.Join(labels, nil))))
			}
			if err != nil {
				return nil, err
			}
		default:
			return nil, errTunnelRecord
		}
	}
	if kind != 1 && kind != 28 {
		if !found {
			return nil, errTunnelRecord
		}
		return single, nil
	}
	if len(parts) == 0 {
		return nil, errTunnelRecord
	}
	joined := make([]byte, 0, len(parts)*(width-1))
	for i := 0; i < len(parts); i++ {
		p, ok := parts[i]
		if !ok {
			return nil, errTunnelRecord
		}
		joined = append(joined, p...)
	}
	if len(joined) < 2 {
		return nil, errTunnelRecord
	}
	n := int(binary.BigEndian.Uint16(joined))
	if n > len(joined)-2 || (n+2+width-2)/(width-1) != len(parts) {
		return nil, errTunnelRecord
	}
	return joined[2 : 2+n], nil
}

func tunnelNameEqual(a, b Name) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !bytes.EqualFold(a[i], b[i]) {
			return false
		}
	}
	return true
}
