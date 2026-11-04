package main

import (
	"encoding/json"
	"strings"
	"testing"
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
