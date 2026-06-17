package beam

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestArchiveDeterministicAndIgnore(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "ignored.txt"), []byte("ignored"), 0o644); err != nil {
		t.Fatal(err)
	}

	syncer := NewFileSyncer(dir, WithoutDefaultIgnoreFile())
	first, firstHash, files, err := syncer.Archive()
	if err != nil {
		t.Fatal(err)
	}
	second, secondHash, files2, err := syncer.Archive()
	if err != nil {
		t.Fatal(err)
	}
	if firstHash != secondHash || !bytes.Equal(first, second) {
		t.Fatalf("archive not deterministic")
	}
	if len(files) != 1 || files[0] != "a.txt" || len(files2) != 1 || files2[0] != "a.txt" {
		t.Fatalf("unexpected files: %v %v", files, files2)
	}

	zr, err := zip.NewReader(bytes.NewReader(first), int64(len(first)))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 1 || zr.File[0].Name != "a.txt" {
		t.Fatalf("unexpected zip entries: %#v", zr.File)
	}
}

func TestArchiveIgnoreAll(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	syncer := NewFileSyncer(dir, WithIgnorePatterns("*"))
	_, _, files, err := syncer.Archive()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("expected all files ignored, got %v", files)
	}
}
