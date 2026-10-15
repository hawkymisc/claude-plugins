// Clawd Cardputer: BLE で受けた Claude Code の状態を Clawd アニメで表示する (SPEC §4, §5)
#include <M5Cardputer.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#include "demo.h"
#include "snapshot.h"
#include "sprites.h"

static const char* DEVICE_NAME = "Clawd-Cardputer";
static const char* SERVICE_UUID = "c1a0d000-7c1e-4b6e-9a55-0c1a0d000001";
static const char* SNAPSHOT_UUID = "c1a0d000-7c1e-4b6e-9a55-0c1a0d000002";

static const int W = 240;
static const int H = 135;
static const int HEADER_H = 14;
static const uint32_t FRAME_MS = 50;      // 描画ループ。アニメ自体は各 Anim の ms で進む
static const uint32_t BATTERY_MS = 10000;

static M5Canvas canvas(&M5.Display);

// BLE コールバック (別タスク) とメインループの受け渡し
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
static char rxBuf[SNAPSHOT_MAX + 1];
static volatile bool rxDirty = false;
static volatile bool isConnected = false;

static Snapshot snap;
static LocalDemo demo;
static uint32_t busyNoticeUntil = 0;  // 「作業中」表示を出しておく期限
static const uint32_t BUSY_NOTICE_MS = 1500;
static int battery = -1;
static uint32_t lastBattery = 0;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    isConnected = true;
    Serial.println("[ble] connected");
  }
  void onDisconnect(BLEServer* server) override {
    isConnected = false;
    Serial.println("[ble] disconnected; advertising again");
    server->getAdvertising()->start();
  }
};

class SnapshotCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String v = c->getValue();
    // 切り詰めると「正しい形の誤ったスナップショット」になりうるので、超過は捨てる
    if (v.length() > SNAPSHOT_MAX) {
      Serial.printf("[rx] dropped oversized write: %u bytes\n", (unsigned)v.length());
      return;
    }
    size_t n = v.length();
    portENTER_CRITICAL(&rxMux);
    memcpy(rxBuf, v.c_str(), n);
    rxBuf[n] = '\0';
    rxDirty = true;
    portEXIT_CRITICAL(&rxMux);
  }
};

static void setupBle() {
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(185);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService* service = server->createService(SERVICE_UUID);
  BLECharacteristic* ch = service->createCharacteristic(
      SNAPSHOT_UUID, BLECharacteristic::PROPERTY_WRITE);
  ch->setCallbacks(new SnapshotCallbacks());
  service->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("[ble] advertising");
}

static void pullSnapshot() {
  if (!rxDirty) return;
  char local[SNAPSHOT_MAX + 1];
  portENTER_CRITICAL(&rxMux);
  memcpy(local, rxBuf, sizeof(local));
  rxDirty = false;
  portEXIT_CRITICAL(&rxMux);
  Snapshot next;
  if (parseSnapshot(local, &next)) {
    snap = next;
    Serial.printf("[rx] %s\n", local);
  } else {
    Serial.printf("[rx] rejected: %s\n", local);
  }
}

static void drawSprite(const Anim& anim, uint8_t frame, int x0, int y0, int scale) {
  const uint8_t (*f)[SPRITE_W] = anim.frames[frame % anim.count];
  for (int y = 0; y < SPRITE_H; y++) {
    for (int x = 0; x < SPRITE_W; x++) {
      uint8_t c = f[y][x];
      if (c) canvas.fillRect(x0 + x * scale, y0 + y * scale, scale, scale, PALETTE565[c]);
    }
  }
}

static uint8_t frameOf(const Anim& anim, uint32_t now) {
  return (now / anim.ms) % anim.count;
}

static void drawHeader() {
  canvas.setTextSize(1);
  canvas.setTextDatum(top_left);
  canvas.setTextColor(isConnected ? TFT_GREEN : TFT_DARKGREY);
  canvas.drawString(isConnected ? "* Mac" : "o waiting", 4, 3);
  char right[24];
  int extra = snap.total > snap.count ? snap.total - snap.count : 0;
  if (extra > 0) {
    snprintf(right, sizeof(right), "+%d  %d%%", extra, battery);
  } else {
    snprintf(right, sizeof(right), "%d%%", battery);
  }
  canvas.setTextDatum(top_right);
  canvas.setTextColor(TFT_LIGHTGREY);
  canvas.drawString(battery < 0 ? "--%" : right, W - 4, 3);
  canvas.drawFastHLine(0, HEADER_H, W, 0x3186);
}

static void drawSlot(const Slot& s, int x, int width, int scale, uint32_t now) {
  const Anim& anim = ANIMS[animFor(s)];
  int sw = SPRITE_W * scale;
  int sh = SPRITE_H * scale;
  int sx = x + (width - sw) / 2;
  int sy = HEADER_H + 6;
  drawSprite(anim, frameOf(anim, now), sx, sy, scale);
  canvas.setTextDatum(top_center);
  canvas.setTextColor(TFT_WHITE);
  canvas.setTextSize(1);
  const char* label = s.tool[0] ? s.tool : s.state;
  canvas.drawString(label, x + width / 2, sy + sh + 4);
}

// スペースキー: 作業していない時に全アニメを順に再生 (もう一度押すと中断)
static void handleKeys(uint32_t now) {
  if (!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return;
  if (!M5Cardputer.Keyboard.keysState().space) return;
  DemoPress r = demo.toggle(now, demoAllowed(snap, isConnected));
  if (r == DemoPress::RefusedBusy) busyNoticeUntil = now + BUSY_NOTICE_MS;
  Serial.printf("[key] space -> demo %s\n",
                r == DemoPress::Started ? "start" : r == DemoPress::Stopped ? "stop" : "refused (Claude is working)");
}

static void drawDemo(int id, uint32_t now) {
  const Anim& anim = ANIMS[id];
  drawSprite(anim, frameOf(anim, now), (W - SPRITE_W * 6) / 2, HEADER_H + 6, 6);
  char label[32];
  snprintf(label, sizeof(label), "demo %d/%d  %s", id + 1, A_COUNT, ANIM_NAMES[id]);
  canvas.setTextDatum(bottom_center);
  canvas.setTextColor(TFT_YELLOW);
  canvas.drawString(label, W / 2, H - 4);
}

static void render(uint32_t now) {
  canvas.fillScreen(TFT_BLACK);
  drawHeader();
  int demoId = demo.animAt(now);
  if (demoId >= 0) {
    drawDemo(demoId, now);
  } else if (!isConnected || snap.count == 0) {
    // 未接続 / セッション無し: 眠る Clawd (まばたきフレーム固定)
    const Anim& idle = ANIMS[A_IDLE];
    drawSprite(idle, idle.count - 1, (W - SPRITE_W * 6) / 2, HEADER_H + 6, 6);
    canvas.setTextDatum(bottom_center);
    canvas.setTextColor(TFT_DARKGREY);
    canvas.drawString(isConnected ? "no Claude sessions" : "waiting for Mac...", W / 2, H - 4);
  } else {
    int width = W / snap.count;
    int scale = snap.count == 1 ? 6 : 4;
    for (int i = 0; i < snap.count; i++) drawSlot(snap.slots[i], i * width, width, scale, now);
  }
  if (now < busyNoticeUntil) {
    canvas.fillRoundRect(30, H / 2 - 12, W - 60, 24, 6, 0x2104);
    canvas.setTextDatum(middle_center);
    canvas.setTextColor(TFT_YELLOW);
    canvas.drawString("Claude is working", W / 2, H / 2);
  }
  canvas.pushSprite(0, 0);
}

void setup() {
  auto cfg = M5.config();
  M5Cardputer.begin(cfg, true);  // ADV のキーボード (TCA8418) も自動判別して初期化
  Serial.begin(115200);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(80);
  canvas.setColorDepth(16);
  canvas.createSprite(W, H);
  snap.total = 0;
  snap.count = 0;
  setupBle();
}

void loop() {
  M5Cardputer.update();
  uint32_t now = millis();
  pullSnapshot();
  handleKeys(now);
  if (now - lastBattery > BATTERY_MS || lastBattery == 0) {
    battery = M5.Power.getBatteryLevel();
    lastBattery = now;
  }
  render(now);
  delay(FRAME_MS);
}
