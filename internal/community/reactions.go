package community

import "slices"

// AllowedReactions defines the curated emoji set matching the frontend ReactionsBar contract.
var AllowedReactions = []string{"👍", "🔥", "💡", "❤️", "🎉"}

func IsAllowedReaction(emoji string) bool {
	return slices.Contains(AllowedReactions, emoji)
}
