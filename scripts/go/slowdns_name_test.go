package dns

import (
	"bytes"
	"math/rand"
	"reflect"
	"testing"
)

// Oracle upstream sebelum sc-fast6; gunakan encoder asli untuk batas panjang.
func scLegacyNewName(labels [][]byte) (Name, error) {
	name := Name(labels)
	for _, label := range labels {
		if len(label) == 0 {
			return nil, ErrZeroLengthLabel
		}
		if len(label) > 63 {
			return nil, ErrLabelTooLong
		}
	}
	builder := newMessageBuilder()
	builder.WriteName(name)
	if len(builder.Bytes()) > 255 {
		return nil, ErrNameTooLong
	}
	return name, nil
}

func TestSCNameValidationParity(t *testing.T) {
	check := func(labels [][]byte) {
		t.Helper()
		want, wantErr := scLegacyNewName(labels)
		got, gotErr := NewName(labels)
		if wantErr != gotErr || !reflect.DeepEqual(want, got) {
			t.Fatalf("nama/error berubah: got=%v want=%v", gotErr, wantErr)
		}
	}
	label := bytes.Repeat([]byte{65}, 63)
	for _, labels := range [][][]byte{
		nil, {}, {{0, '.', '\\', 255}}, {{}},
		{label, label, label, bytes.Repeat([]byte{66}, 61)}, // 255 byte
		{label, label, label, bytes.Repeat([]byte{66}, 62)}, // 256 byte
		{label, label, label, label, {}},                    // error label tetap didahulukan
		{label, label, label, label, bytes.Repeat([]byte{67}, 64)},
	} {
		check(labels)
	}
	rng := rand.New(rand.NewSource(122))
	for i := 0; i < 12000; i++ {
		var labels [][]byte
		for n := rng.Intn(70); n > 0; n-- {
			label := make([]byte, rng.Intn(70))
			rng.Read(label)
			labels = append(labels, label)
		}
		check(labels)
	}
	labels := [][]byte{[]byte("example"), []byte("com")}
	if allocs := testing.AllocsPerRun(100, func() { _, _ = NewName(labels) }); allocs != 0 {
		t.Fatalf("validasi nama harus tanpa alokasi, got %.1f", allocs)
	}
	name, _ := NewName(labels)
	labels[0][0] = 'E'
	if name[0][0] != 'E' {
		t.Fatal("kepemilikan label berubah; upstream tidak menyalin label di NewName")
	}
}
