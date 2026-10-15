// ローカル demo (スペースキー) の仕様テスト: c++ -std=c++17 test_demo.cpp && ./a.out
#include <cstdio>
#include "../clawd_cardputer/demo.h"

static int failures = 0;
#define CHECK(x) do { if (!(x)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #x); failures++; } } while (0)

static Snapshot snap(const char* text) {
  Snapshot s{};
  parseSnapshot(text, &s);
  return s;
}

int main() {
  // 作業していない時だけ demo を始められる
  CHECK(demoAllowed(snap("1|0"), false));                         // 未接続
  CHECK(demoAllowed(snap("1|0"), true));                          // セッションなし
  CHECK(demoAllowed(snap("1|2|idle,-,-|done,-,-"), true));        // 全員 idle / done
  CHECK(!demoAllowed(snap("1|2|idle,-,-|tool,read,Read"), true)); // 誰かが作業中
  CHECK(!demoAllowed(snap("1|1|thinking,-,-"), true));
  CHECK(!demoAllowed(snap("1|1|waiting,-,Bash"), true));
  CHECK(!demoAllowed(snap("1|4|idle,-,-|idle,-,-|idle,-,-"), true)); // 見えない 4 人目は不明 → 不可

  // 全アニメを順に DEMO_STEP_MS ずつ。終わったら -1
  CHECK(demoAnimAt(0) == 0);
  CHECK(demoAnimAt(DEMO_STEP_MS - 1) == 0);
  CHECK(demoAnimAt(DEMO_STEP_MS) == 1);
  CHECK(demoAnimAt(DEMO_STEP_MS * (A_COUNT - 1)) == A_COUNT - 1);
  CHECK(demoAnimAt(DEMO_STEP_MS * A_COUNT) == -1);

  // スペースで開始・もう一度で中断。作業中は開始しない
  LocalDemo d{};
  CHECK(!d.active);
  d.toggle(1000, true);
  CHECK(d.active && d.startedAt == 1000);
  CHECK(d.animAt(1000 + DEMO_STEP_MS) == 1);
  d.toggle(2000, true);
  CHECK(!d.active);
  d.toggle(3000, false);
  CHECK(!d.active);
  // 最後まで再生したら自動で終わる
  d.toggle(0, true);
  CHECK(d.animAt(DEMO_STEP_MS * A_COUNT) == -1 && !d.active);
  // 始まった demo は Claude が作業を始めても最後まで流す (自動中断しない)
  CHECK(DEMO_STEP_MS == 3000);
  d.toggle(0, true);
  CHECK(d.animAt(DEMO_STEP_MS * 5) == 5 && d.active);
  // 作業中の押下は開始せず「断った」と分かる
  LocalDemo e{};
  CHECK(e.toggle(0, false) == DemoPress::RefusedBusy && !e.active);
  CHECK(e.toggle(0, true) == DemoPress::Started);
  CHECK(e.toggle(1, true) == DemoPress::Stopped);

  std::printf(failures ? "%d failure(s)\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
