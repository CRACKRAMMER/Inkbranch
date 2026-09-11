---
title: Reading time is wrong for Chinese
date: 2026-06-30
updated: 2026-08-28
tags: [Data, Writing]
category: Data
---

The standard formula is words ÷ 200. Applied to Chinese it produces nonsense,
because "words" was never the unit.

Chinese has no spaces, so `split(/\s+/)` on a Chinese paragraph returns **one**
token. A 3,000-character essay reports as "1 word, 1 min read". Every blog that
computes reading time this way and then writes in Chinese is displaying a number
that is off by an order of magnitude.

## The fix

Count both scripts, each at its own rate:

```ts
const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/

let cjk = 0
let latinWords = 0
let inWord = false

for (const char of text) {
  if (CJK.test(char)) {
    cjk += 1
    inWord = false
  } else if (/\s/.test(char)) {
    inWord = false
  } else if (!inWord) {
    latinWords += 1
    inWord = true
  }
}

const minutes = cjk / 400 + latinWords / 220
```

The rates differ because the units do: 220 **words** per minute for English,
400 **characters** per minute for Chinese. Comparing them directly is comparing
a word to a character.

## Why 400

Estimates in the literature run from 260 to 500 characters per minute for
Chinese, and the spread is real — it depends on the reader and the text.
400 sits in the upper middle and matches what other Chinese-language
publications use, which matters more than being precisely right: the number is
a signal for "settle in" versus "quick read", and a consistent approximation
serves that better than an inconsistent accurate one.

The output is rounded up and floored at 1. Nothing accurate is lost, because a
"3 min read" was never a measurement.

The same assumption — that words are separated by spaces — costs far more in
[[searching-chinese]], where it decides whether a query returns anything at all.
