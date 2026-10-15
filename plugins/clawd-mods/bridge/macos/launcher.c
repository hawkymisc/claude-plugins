// ClawdBridge.app のメイン実行ファイル。
// python を「子プロセス」として起動して待つ。macOS の TCC は子プロセスの
// Bluetooth アクセスを responsible process (= この .app) に帰属させるので、
// .app の Info.plist の NSBluetoothAlwaysUsageDescription が効く (PLAN R1)。
// exec で置き換えると python 自身が responsible になり kill されるため spawn する。
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;
static pid_t child = 0;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

int main(int argc, char **argv) {
  // argv[1..] = 実行する python とその引数 (LaunchAgent の ProgramArguments から渡す)
  if (argc < 2) {
    fprintf(stderr, "usage: %s <python> [args...]\n", argv[0]);
    return 64;
  }
  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  int rc = posix_spawn(&child, argv[1], NULL, NULL, &argv[1], environ);
  if (rc != 0) {
    fprintf(stderr, "clawd launcher: spawn %s failed: %s\n", argv[1], strerror(rc));
    return 70;
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) {
      perror("clawd launcher: waitpid");
      return 71;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    fprintf(stderr, "clawd launcher: child killed by signal %d\n", WTERMSIG(status));
    return 128 + WTERMSIG(status);
  }
  return 1;
}
