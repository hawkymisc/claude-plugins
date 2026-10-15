// スペースキーで再生するローカル demo (全アニメを順に見せる)。
// ホスト側テスト (firmware/test/test_demo.cpp) からも include するため Arduino 依存を持たない。
#pragma once
#include <stdint.h>
#include <string.h>

#include "snapshot.h"
#include "sprites.h"

#define DEMO_STEP_MS 3000

// Claude が作業していない時だけ demo を始められる:
// 未接続 / セッションなし / 表示中の全員が idle か done。画面外のセッションがあれば不可。
static inline bool demoAllowed(const Snapshot& s, bool connected) {
  if (!connected || s.total == 0) return true;
  if (s.total > s.count) return false;
  for (int i = 0; i < s.count; i++) {
    if (strcmp(s.slots[i].state, "idle") != 0 && strcmp(s.slots[i].state, "done") != 0) return false;
  }
  return true;
}

// 開始からの経過時間で見せるアニメ。全部見せ終わったら -1。
static inline int demoAnimAt(uint32_t elapsed) {
  uint32_t i = elapsed / DEMO_STEP_MS;
  return i < (uint32_t)A_COUNT ? (int)i : -1;
}

enum class DemoPress { Started, Stopped, RefusedBusy };

struct LocalDemo {
  bool active = false;
  uint32_t startedAt = 0;

  // スペース押下: 再生中なら中断、作業していなければ開始、作業中なら断る。
  // 始まった demo は Claude が作業を始めても最後まで流す (見ている途中で消さない)
  DemoPress toggle(uint32_t now, bool allowed) {
    if (active) {
      active = false;
      return DemoPress::Stopped;
    }
    if (!allowed) return DemoPress::RefusedBusy;
    active = true;
    startedAt = now;
    return DemoPress::Started;
  }

  // 今見せるアニメ。終わっていれば自動で非アクティブにして -1
  int animAt(uint32_t now) {
    if (!active) return -1;
    int id = demoAnimAt(now - startedAt);
    if (id < 0) active = false;
    return id;
  }
};
