package beam

import "testing"

func TestQuoteArgv(t *testing.T) {
	got := quoteArgv([]string{"python3", "-c", "print('hello world')", ""})
	want := `python3 -c 'print('"'"'hello world'"'"')' ''`
	if got != want {
		t.Fatalf("quoteArgv() = %q, want %q", got, want)
	}
}

func TestParseEnv(t *testing.T) {
	got := parseEnv([]string{"A=1", "B=two=parts", "ignored"})
	if got["A"] != "1" || got["B"] != "two=parts" {
		t.Fatalf("unexpected env: %#v", got)
	}
	if _, ok := got["ignored"]; ok {
		t.Fatalf("entry without '=' should be ignored")
	}
}
