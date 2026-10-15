// スナップショット "1|<total>|<state>,<category>,<tool>|..." のパーサ (SPEC §4)
// ホスト側テスト (firmware/test/) からも include するため Arduino 依存を持たない。
#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "sprites.h"

#define SNAPSHOT_MAX 180
#define MAX_SLOTS 3

struct Slot {
  char state[10];
  char category[8];
  char tool[13];
};

struct Snapshot {
  int total;
  int count;
  Slot slots[MAX_SLOTS];
};

static inline bool copyField(char* dst, size_t cap, const char* src, size_t n) {
  if (n >= cap) return false;
  memcpy(dst, src, n);
  dst[n] = '\0';
  if (n == 1 && dst[0] == '-') dst[0] = '\0';
  return true;
}

// 1 スロット "state,category,tool" を読む
static inline bool parseSlot(const char* s, size_t n, Slot* out) {
  const char* end = s + n;
  const char* c1 = (const char*)memchr(s, ',', n);
  if (!c1) return false;
  const char* c2 = (const char*)memchr(c1 + 1, ',', end - c1 - 1);
  if (!c2) return false;
  return copyField(out->state, sizeof(out->state), s, c1 - s) &&
         copyField(out->category, sizeof(out->category), c1 + 1, c2 - c1 - 1) &&
         copyField(out->tool, sizeof(out->tool), c2 + 1, end - c2 - 1);
}

static inline bool parseSnapshot(const char* text, Snapshot* out) {
  size_t len = strnlen(text, SNAPSHOT_MAX + 1);
  if (len > SNAPSHOT_MAX || len < 3 || text[0] != '1' || text[1] != '|') return false;
  const char* p = text + 2;
  char* after = nullptr;
  long total = strtol(p, &after, 10);
  if (after == p || total < 0 || total > 99) return false;
  out->total = (int)total;
  out->count = 0;
  p = after;
  while (*p == '|' && out->count < MAX_SLOTS) {
    p++;
    const char* bar = strchr(p, '|');
    size_t n = bar ? (size_t)(bar - p) : strlen(p);
    if (!parseSlot(p, n, &out->slots[out->count])) return false;
    out->count++;
    p += n;
  }
  return *p == '\0' && out->count <= out->total;
}

static inline int animByName(const char* name) {
  for (int i = 0; i < A_COUNT; i++) {
    if (strcmp(ANIM_NAMES[i], name) == 0) return i;
  }
  return -1;
}

// state=tool なら category のアニメ、それ以外は state 名のアニメ。不明は other。
static inline int animFor(const Slot& s) {
  int id = animByName(strcmp(s.state, "tool") == 0 ? s.category : s.state);
  return id >= 0 ? id : A_OTHER;
}
