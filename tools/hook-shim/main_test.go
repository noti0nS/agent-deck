package main

import (
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestEnvelopePreservesNativeIdentity(t *testing.T) {
	raw := []byte(`{"conversationId":"conversation-1","toolCall":{"name":"run_command"},"source":"untrusted","hook_event_name":"incorrect"}`)
	var got map[string]interface{}
	if err := json.Unmarshal(preparePayload(raw, "agy", "PreToolUse"), &got); err != nil {
		t.Fatal(err)
	}
	if got["conversationId"] != "conversation-1" || got["source"] != "untrusted" || got["_agent_deck_source"] != "agy" || got["hook_event_name"] != "PreToolUse" {
		t.Fatalf("incorrect native hook envelope: %v", got)
	}
}

func TestInvalidOrOversizedPayloadIsDroppedNotTruncated(t *testing.T) {
	for _, raw := range []string{"", "{", "null", "[]", `{"text":"` + strings.Repeat("a", maxPayload) + `"}`} {
		if preparePayload([]byte(raw), "", "") != nil {
			t.Fatalf("expected invalid or oversized payload to be dropped")
		}
	}
}

func TestOnlyLoopbackTelemetry(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:4101", "[::1]:4102"} {
		if !loopbackAddress(addr) {
			t.Fatalf("rejected loopback %s", addr)
		}
	}
	for _, addr := range []string{"0.0.0.0:4101", "192.168.1.2:4102", "example.com:4101", "127.0.0.1:0", "127.0.0.1:65536"} {
		if loopbackAddress(addr) {
			t.Fatalf("accepted non-loopback or invalid destination %s", addr)
		}
	}
}

type delayedReader struct {
	io.Reader
	delay time.Duration
}

func (r *delayedReader) Read(p []byte) (int, error) {
	time.Sleep(r.delay)
	r.delay = 0
	return r.Reader.Read(p)
}

func TestDelayedInputDoesNotConsumeWriteDeadline(t *testing.T) {
	receiver, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	input := &delayedReader{
		Reader: strings.NewReader(`{"session_id":"delayed-input","hook_event_name":"Stop","last_assistant_message":"Delivered after input delay."}`),
		delay:  50 * time.Millisecond,
	}
	sendPayload(input, receiver.LocalAddr().String(), "claude", "")
	if err := receiver.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, maxPayload)
	n, _, err := receiver.ReadFrom(buf)
	if err != nil {
		t.Fatalf("hook payload lost after delayed input: %v", err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(buf[:n], &payload); err != nil {
		t.Fatal(err)
	}
	if payload["session_id"] != "delayed-input" || payload["last_assistant_message"] != "Delivered after input delay." {
		t.Fatalf("unexpected hook payload: %v", payload)
	}
}
