---
title: Full-Text Search That Handles Chinese and English at Once
slug: searching-chinese
description: Whitespace tokenisation silently fails for CJK. Bigrams, BM25F field weighting, and why the index has to store the stem as well as the word.
date: 2026-08-21
tags: [Search, Data, Engineering]
category: Engineering
featured: true
---

Every search implementation starts with `text.split(/\s+/)`. For English that
is roughly right. For Chinese it is catastrophically wrong, and — worse — it
fails *silently*, returning zero results with no error to explain them.

## Why splitting on spaces fails

Chinese does not put spaces between words. The sentence

> 分布式系统的共识算法

is one "word" to a whitespace tokeniser. A reader searching for 共识
("consensus") gets nothing, because that string is not a token — it is a
substring of a token, and inverted indexes match tokens.

The library answer is a real segmenter (jieba, kuromoji, ICU's
dictionary-based breaking). Those work well. They also add a large dependency,
a dictionary to ship, and a new class of "why did it split it *there*" bug.

## Bigrams: two characters at a time

A cheaper approach that works remarkably well: index every adjacent pair of CJK
characters. The sentence above becomes

```
分布 布式 式系 系统 统的 的共 共识 识算 算法
```

A search for 共识 now hits, because 共识 *is* a token. So does 算法. So does
any two-character word in the text, which covers the overwhelming majority of
Chinese vocabulary.

:::note[The cost, stated honestly]
Bigrams roughly double the index size for CJK text, and they lose
single-character queries — searching for 的 matches nothing, because no bigram
equals it. That is usually fine: one character is rarely a useful query, and the
alternative (indexing unigrams too) triples the index to serve queries nobody
makes.
:::

The implementation is a small loop. The subtlety is that CJK and Latin have to
coexist in one token stream, so the tokeniser walks the string and switches
mode:

```ts title="src/lib/search/tokenize.ts"
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let latin = ''

  const flush = () => {
    if (latin) {
      tokens.push(latin.toLowerCase())
      latin = ''
    }
  }

  for (const char of text) {
    if (isCjk(char)) {
      flush()
      // Handled by the bigram pass below, which needs to see the run intact.
    } else if (/[\p{L}\p{N}]/u.test(char)) {
      latin += char
    } else {
      flush()
    }
  }

  flush()
  return [...tokens, ...bigrams(text)]
}
```

## Ranking: BM25, with fields

Once tokens exist, scoring is BM25 — the standard, and standard for good reason:
it saturates term frequency (the tenth occurrence of a word adds less than the
second) and normalises by document length (a long document is not more relevant
just for being long).

The variant here is **BM25F**, which scores fields separately and combines them.
A match in the title is worth more than a match in the body:

| Field | Weight | Why |
| --- | ---: | --- |
| Title | 8 | What the document is *about* |
| Tags | 6 | Explicitly chosen by the author |
| Description | 4 | A summary the author wrote |
| Headings | 3 | Structure, but noisier than the title |
| Body | 1 | The baseline |

Weights are tuned by the formula

$$\text{score}(q, d) = \sum_{t \in q} \text{IDF}(t) \cdot \frac{f(t,d) \cdot (k_1 + 1)}{f(t,d) + k_1 \cdot \left(1 - b + b \cdot \frac{|d|}{\text{avgdl}}\right)}$$

with $k_1 = 1.2$ and $b = 0.75$ — the values from the original paper, which have
held up well enough that deviating needs evidence rather than taste.

## Stemming, and the bug it hides

English queries want stemming: searching `deploy` should find "deploying" and
"deployment". Naively, you stem at index time and stem at query time, and they
match.

The bug: the index no longer contains the word the author wrote, so
*highlighting* the match in the excerpt has nothing to highlight. You get a
result with no visible reason for matching.

The fix is to store both — the original form and the stem — as separate tokens
pointing at the same position:

```ts
// Two tokens, one position. The stem is what matches; the written form is what
// gets highlighted. Storing only the stem makes results unexplainable; storing
// only the written form makes "deploy" miss "deployment".
tokens.push({ value: written, position: index })
tokens.push({ value: stem(written), position: index })
```

Queries are then expanded into *term groups*: groups are ANDed, and the forms
within a group are ORed. `deploy` becomes one group containing `deploy` and
`deploy` (its own stem), matched if either hits.

## Where this stops working

This design is good to a few thousand documents. The index is in process memory,
rebuilt from the database, and a rebuild is O(all content). Past that, the honest
answer is a real search server — which is why the provider is an interface with
one implementation, not a function called from twenty places.

The switch should cost one file and one environment variable. If it costs more
than that, the abstraction was in the wrong place.

This is the search layer of [[MyBlog]]; [[reading-time-cjk]] is the same problem
— whitespace tokenisation applied to a language that does not use it — showing
up in a much smaller piece of code.
