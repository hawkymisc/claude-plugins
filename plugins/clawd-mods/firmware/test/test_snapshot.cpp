// ホスト上で snapshot.h の仕様 (SPEC §4) を検査する: c++ -std=c++17 test_snapshot.cpp && ./a.out
#include <cassert>
#include <cstdio>
#include "../clawd_cardputer/snapshot.h"

static int failures = 0;
#define CHECK(x) do { if (!(x)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #x); failures++; } } while (0)

int main() {
  Snapshot s;
  CHECK(parseSnapshot("1|0", &s) && s.total == 0 && s.count == 0);
  CHECK(parseSnapshot("1|1|tool,write,Edit", &s) && s.count == 1);
  CHECK(strcmp(s.slots[0].state, "tool") == 0 && strcmp(s.slots[0].tool, "Edit") == 0);
  CHECK(animFor(s.slots[0]) == A_WRITE);
  CHECK(parseSnapshot("1|1|thinking,-,-", &s) && s.slots[0].category[0] == '\0' && s.slots[0].tool[0] == '\0');
  CHECK(animFor(s.slots[0]) == A_THINKING);
  CHECK(parseSnapshot("1|5|idle,-,-|tool,bash,Bash|waiting,-,Read", &s) && s.total == 5 && s.count == 3);
  CHECK(animFor(s.slots[1]) == A_BASH && animFor(s.slots[2]) == A_WAITING);
  // 不正入力は拒否
  CHECK(!parseSnapshot("2|0", &s));
  CHECK(!parseSnapshot("1|x", &s));
  CHECK(!parseSnapshot("1|1|tool,write", &s));
  CHECK(!parseSnapshot("1|1|tool,write,abcdefghijklm", &s));  // tool 13 文字は超過
  CHECK(!parseSnapshot("1|0|idle,-,-", &s));                  // count > total
  CHECK(!parseSnapshot("1|4|a,-,-|b,-,-|c,-,-|d,-,-", &s));   // 4 スロット目は不可
  CHECK(!parseSnapshot("1|100", &s));                         // total 上限 99 (bridge 側で clamp)
  CHECK(!parseSnapshot("1|-1", &s));
  CHECK(!parseSnapshot("1|1|idle,-,-|", &s));                 // 末尾の |
  CHECK(!parseSnapshot("1|1|abcdefghij,-,-", &s));            // state 10 文字は超過
  CHECK(parseSnapshot("1|99|idle,-,-", &s) && s.total == 99);
    // 未知の状態は other
  CHECK(parseSnapshot("1|1|tool,zzz,X", &s) && animFor(s.slots[0]) == A_OTHER);
  std::printf(failures ? "%d failure(s)\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
