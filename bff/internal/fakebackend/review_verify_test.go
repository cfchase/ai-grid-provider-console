package fakebackend

// Verification test for PR 12 review comment 12: the fake's model filter and
// the BFF's quoting. Passes when the claim is NOT true.

import (
	"strings"
	"testing"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// bffQuote is the BFF's `quote` in api/models.go listModels, verbatim.
func bffQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func TestVerifyC12EscapedLabelValues(t *testing.T) {
	for _, value := range []string{`a\b`, `a"b`, `a && b`} {
		filter := "this.metadata.labels[" + bffQuote("team") + "] == " + bffQuote(value)
		m := &aigridv1.Model{Name: "m", Metadata: &aigridv1.ObjectMeta{Namespace: "ns", Labels: map[string]string{"team": value}}}
		match, err := parseModelFilter(filter)
		switch {
		case err != nil:
			t.Errorf("value %q: filter %s rejected: %v", value, filter, err)
		case !match(m):
			t.Errorf("value %q: filter %s does not match a model carrying it", value, filter)
		}
	}
}
