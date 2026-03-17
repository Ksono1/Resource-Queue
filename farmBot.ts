import { storage } from "../storage";
import { BotCore } from "./core";

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function humanDelay(min = 800, max = 2000) {
  const delay = randomBetween(min, max);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export class FarmBot {
  private farmRunning = false;
  private farmTimer: any = null;
  private nextLongBreakAt: number = 0;
  public nextActionAt: number = 0;

  constructor(private core: BotCore) {}

  get isRunning() {
    return this.farmRunning;
  }

  // ================= START =================

  async start() {
    if (!this.core.page || this.core.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany." };
    }

    if (this.farmRunning) {
      return { success: false, error: "FarmBot już działa." };
    }

    this.farmRunning = true;
    this.nextLongBreakAt = this.generateNextLongBreakTime();

    const startDelay = randomBetween(8000, 25000);
    this.nextActionAt = Date.now() + startDelay;

    await storage.updateFarmSettings({
      botState: "active",
      nextActionSeconds: Math.round(startDelay / 1000),
      lastCollectAgo: "Startuje...",
      nextLongBreak: "Obliczanie...",
      randomDelay: "",
    });

    await this.addLog("FarmBot wystartował.", "success");

    await this.syncCitiesFromGame();

    this.farmTimer = setTimeout(() => this.collect(), startDelay);

    return { success: true };
  }

  stop() {
    this.farmRunning = false;
    this.nextActionAt = 0;

    if (this.farmTimer) clearTimeout(this.farmTimer);
    this.farmTimer = null;
  }

  async pause() {
    this.stop();
    await storage.updateFarmSettings({
      botState: "paused",
      nextActionSeconds: 0,
    });
    await this.addLog("FarmBot wstrzymany.", "warning");
    return { success: true };
  }

  async resume() {
    return this.start();
  }

  async forceCollect() {
    if (!this.core.page || this.core.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany." };
    }

    if (this.farmTimer) clearTimeout(this.farmTimer);

    await this.addLog("Wymuszono natychmiastowe zbiory.", "warning");

    await this.collect();

    return { success: true };
  }

  // ================= COLLECT =================

  private async collect() {
    if (!this.farmRunning || !this.core.page) return;

    try {
      await this.addLog("Rozpoczęto cykl zbierania.", "info");

      await this.core.page.waitForFunction(
        () => window.Game && window.Game.player_id,
        { timeout: 15000 }
      );

      const captainButton =
        "div.toolbar_buttons > div.toolbar_button.premium";
      const villagesButton = 'a[name="farm_town_overview"]';
      const selectAllButton = "div.game_header a.checkbox.select_all";
      const claimButton = "#fto_claim_button";

      await this.core.page.waitForSelector(captainButton, {
        visible: true,
        timeout: 15000,
      });

      await this.core.page.hover(captainButton);
      await humanDelay(1000, 1800);

      await this.addLog("KAPITAN: Hover na Podglądy...", "info");

      await this.safeClick(villagesButton);
      await this.safeClick(selectAllButton);

      const isClaimEnabled = await this.core.page.evaluate(() => {
        const btn = document.querySelector("#fto_claim_button");
        if (!btn) return false;
        return !btn.classList.contains("disabled");
      });

      if (!isClaimEnabled) {
        await this.addLog("Cooldown aktywny — nie zbieram.", "warning");
        return this.scheduleNextCollect();
      }

      await this.safeClick(claimButton);

      await this.addLog(
        "Zebrano surowce ze wszystkich wiosek.",
        "success"
      );

      await this.syncCitiesFromGame();

      this.scheduleNextCollect();
    } catch (err: any) {
      await this.addLog(`Błąd: ${err.message}`, "error");
      this.scheduleNextCollect();
    }
  }

  // ================= SAFE CLICK =================

  private async safeClick(selector: string) {
    if (!this.core.page) return;

    await this.core.page.waitForSelector(selector, {
      visible: true,
      timeout: 15000,
    });

    await humanDelay(600, 1200);

    await this.core.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("Nie znaleziono elementu: " + sel);
      (el as HTMLElement).scrollIntoView({ block: "center" });
      (el as HTMLElement).click();
    }, selector);

    await humanDelay(800, 1500);
  }

  // ================= SYNC (Z BUDYNKAMI + KOLEJKA BUDOWY) =================

  private async syncCitiesFromGame() {
    if (!this.core.page) return;

    try {
      const cities = await this.core.page.evaluate(() => {
        if (typeof ITowns === "undefined") return [];

        const townsObject = ITowns.getTowns();
        if (!townsObject) return [];

        const townsArray = Object.values(townsObject);

        return townsArray.map((town: any) => {
          const resources = town.resources?.() || {};
          const buildings = town.buildings?.()?.attributes || {};

          // 🔥 BUILD QUEUE — Backbone Collection (.models[].attributes)
          var buildQueue: any[] = [];
          try {
            var ordersCollection = town.buildingOrders?.() || town.getBuildingOrders?.() || null;
            if (ordersCollection) {
              var orderModels = ordersCollection.models || [];
              for (var oi = 0; oi < orderModels.length; oi++) {
                var model = orderModels[oi];
                if (!model || !model.attributes) continue;
                var attr = model.attributes;
                buildQueue.push({
                  building: attr.building_type || '',
                  town_id: attr.town_id || 0,
                  tear_down: attr.tear_down || false
                });
              }
            }
          } catch(e) {}

          return {
            gameId: town.id,
            name: town.name,
            wood: resources.wood ?? 0,
            stone: resources.stone ?? 0,
            silver: resources.iron ?? 0,
            population: resources.population ?? 0,
            buildings,

            buildQueue: buildQueue,

            islandX: town.getIslandCoordinateX(),
            islandY: town.getIslandCoordinateY(),
            ocean:
              "M" +
              Math.floor(town.getIslandCoordinateX() / 100) +
              Math.floor(town.getIslandCoordinateY() / 100),
          };
        });
      });

      if (!Array.isArray(cities)) return;

      await storage.syncCities(cities);
    } catch (err: any) {
      await this.addLog(
        `Błąd synchronizacji miast: ${err.message}`,
        "error"
      );
    }
  }

  // ================= SCHEDULER =================

  private async scheduleNextCollect() {
    if (!this.farmRunning) return;

    const baseDelay = 10 * 60 * 1000;
    const extraDelay = randomBetween(5000, 120000);
    const totalDelay = baseDelay + extraDelay;

    const nextBreakMin = Math.max(
      0,
      Math.round((this.nextLongBreakAt - Date.now()) / 60000)
    );

    this.nextActionAt = Date.now() + totalDelay;

    await storage.updateFarmSettings({
      botState: "active",
      nextActionSeconds: Math.round(totalDelay / 1000),
      lastCollectAgo: "Właśnie teraz",
      nextLongBreak: `Za ok. ${nextBreakMin} min`,
      randomDelay: `+${(extraDelay / 1000).toFixed(1)}s`,
    });

    this.farmTimer = setTimeout(() => this.collect(), totalDelay);
  }

  private generateNextLongBreakTime() {
    return Date.now() + randomBetween(3 * 3600000, 6 * 3600000);
  }

  private async addLog(message: string, type: string) {
    const now = new Date();
    const time = now.toLocaleTimeString("pl-PL", { hour12: false });
    await storage.addFarmLog({ time, type, message });
  }
}