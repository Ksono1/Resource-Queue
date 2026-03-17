import { storage } from "./storage";
import { log } from "./index";
import { notifyDataUpdate } from "./routes";
import { CultureBot } from "./Resorce queue/cultureBot";
import { BotCore } from "./Resorce queue/core";

function getStorageCapacity(level: number) {
  const cap: Record<number, number> = {
    1:300, 2:711, 3:1185, 4:1706, 5:2267, 6:2862, 7:3487, 8:4140,
    9:4818, 10:5518, 11:6241, 12:6984, 13:7746, 14:8526, 15:9325,
    16:10138, 17:10769, 18:11815, 19:12675, 20:13550, 21:14439,
    22:15341, 23:16257, 24:17185, 25:18125, 26:19077, 27:20041,
    28:21016, 29:22003, 30:23000
  };
  return cap[level] || 23000;
}

let puppeteerModule: any = null;
let stealthPlugin: any = null;

async function loadPuppeteer() {
  try {
    const pExtra = await import("puppeteer-extra");
    const stealth = await import("puppeteer-extra-plugin-stealth");
    puppeteerModule = pExtra.default || pExtra;
    stealthPlugin = stealth.default || stealth;
    puppeteerModule.use(stealthPlugin());
    return true;
  } catch (e) {
    log("Puppeteer nie jest zainstalowany - bot niedostępny", "bot");
    return false;
  }
}

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function humanDelay(min = 800, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

class BotManager {
  private page: any = null;
  private browser: any = null;
  private farmRunning = false;
  private farmTimer: any = null;
  private syncTimer: any = null;
  private buildTimer: any = null;
  private builderRunning = false;
  private builderAutoMode = false;
  private marketRunning = false;
  private marketTimer: any = null;
  private cultureBot: CultureBot | null = null;
  private nextLongBreakAt: number = 0;
  private status: string = "offline";
  private nextActionAt: number = 0;

  getStatus() {
    const now = Date.now();
    const secondsLeft = this.nextActionAt > now ? Math.round((this.nextActionAt - now) / 1000) : 0;

    return {
      status: this.status,
      hasBrowser: !!this.browser,
      hasPage: !!this.page,
      farmRunning: this.farmRunning,
      marketRunning: this.marketRunning,
      builderRunning: this.builderRunning,
      builderAutoMode: this.builderAutoMode,
      cultureRunning: !!this.cultureBot && (this.cultureBot.isEventRunning('festival') || this.cultureBot.isEventRunning('games') || this.cultureBot.isEventRunning('triumph') || this.cultureBot.isEventRunning('theater')),
      nextActionAt: this.nextActionAt,
      nextActionSeconds: secondsLeft,
    };
  }

  async startBot() {
    if (this.browser) {
      return { success: false, error: "Bot już działa" };
    }

    const loaded = await loadPuppeteer();
    if (!loaded) {
      return {
        success: false,
        error: "Puppeteer nie jest zainstalowany. Uruchom: npm install",
      };
    }

    this.status = "launching";
    await this.addLog("Uruchamiam przeglądarkę...", "info");

    try {
      this.browser = await puppeteerModule.launch({
        headless: false,
        defaultViewport: null,
      });

      this.page = await this.browser.newPage();
      await this.page.goto("https://pl-play.grepolis.com/?logout=true");

      this.status = "waiting_login";
      await this.addLog(
        "Przeglądarka otwarta — zaloguj się ręcznie do Grepolisa!",
        "warning"
      );

      this.waitForLogin();

      return { success: true, status: "waiting_login" };
    } catch (err: any) {
      this.status = "offline";
      await this.addLog(`Błąd startu: ${err.message}`, "error");
      return { success: false, error: err.message };
    }
  }

  private async waitForLogin() {
    try {
      await this.page.waitForFunction(
        () => {
          return (
            window.location.hostname.includes("pl") &&
            window.location.hostname.includes("grepolis.com") &&
            window.location.hostname !== "pl-play.grepolis.com"
          );
        },
        { timeout: 300000 }
      );

      log("Wykryto przejście do świata gry", "bot");
      await this.addLog("Wykryto logowanie — ładuję świat gry...", "info");

      await this.page.waitForFunction(
        () => window.Game && window.Game.csrfToken,
        { timeout: 60000 }
      );

      log("Token gry wykryty", "bot");

      await this.page.waitForFunction(
        () =>
          typeof ITowns !== "undefined" &&
          Object.keys(ITowns.getTowns()).length > 0,
        { timeout: 60000 }
      );

      this.status = "active";
      this.nextLongBreakAt = this.generateNextLongBreakTime();
      await this.addLog("Zalogowano! Bot aktywny.", "success");

      await storage.updateFarmSettings({ botState: "active" });

      this.startSyncLoop();
      this.startFarming();
    } catch (err: any) {
      this.status = "offline";
      await this.addLog(
        `Logowanie nie powiodło się: ${err.message}`,
        "error"
      );
    }
  }

  async stopBot() {
    this.status = "offline";
    this.farmRunning = false;
    this.marketRunning = false;
    this.builderRunning = false;
    this.builderAutoMode = false;
    this.nextActionAt = 0;

    if (this.farmTimer) clearTimeout(this.farmTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.buildTimer) { clearInterval(this.buildTimer); clearTimeout(this.buildTimer); }
    if (this.marketTimer) clearTimeout(this.marketTimer);
    if (this.cultureBot) this.cultureBot.stopAll();
    this.farmTimer = null;
    this.syncTimer = null;
    this.buildTimer = null;
    this.marketTimer = null;

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.page = null;
    }

    await storage.updateFarmSettings({ botState: "offline", nextActionSeconds: 0 });
    await this.addLog("Bot zatrzymany.", "warning");

    return { success: true };
  }

  async pauseFarm() {
    this.farmRunning = false;
    this.nextActionAt = 0;
    if (this.farmTimer) {
      clearTimeout(this.farmTimer);
      this.farmTimer = null;
    }
    await storage.updateFarmSettings({ botState: "paused", nextActionSeconds: 0 });
    await this.addLog("FarmBot wstrzymany.", "warning");
    return { success: true };
  }

  async resumeFarm() {
    if (!this.page || this.status !== "active") {
      return {
        success: false,
        error: "Bot nie jest zalogowany. Najpierw uruchom bota.",
      };
    }
    this.farmRunning = true;
    await storage.updateFarmSettings({ botState: "active" });
    await this.addLog("FarmBot wznowiony.", "success");
    this.scheduleNextCollect();
    return { success: true };
  }

  async forceCollect() {
    if (!this.page || this.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany." };
    }
    if (this.farmTimer) clearTimeout(this.farmTimer);
    this.farmRunning = true;
    this.nextActionAt = 0;
    await storage.updateFarmSettings({ botState: "active", nextActionSeconds: 0 });
    this.collect();
    return { success: true };
  }

  private startFarming() {
    this.farmRunning = true;
    const startDelay = randomBetween(8000, 25000);
    log(
      `FarmBot wystartuje za ${(startDelay / 1000).toFixed(1)}s`,
      "bot"
    );
    this.nextActionAt = Date.now() + startDelay;
    this.farmTimer = setTimeout(() => this.collect(), startDelay);
  }

  private async collect() {
    if (!this.farmRunning || !this.page) return;

    try {
      log("collect() start", "farm");
      await this.addLog("Rozpoczęto cykl zbierania.", "info");

      await this.page.waitForFunction(
        () => window.Game && window.Game.player_id,
        { timeout: 10000 }
      );

      const captainButton =
        "div.toolbar_buttons > div.toolbar_button.premium";
      const villagesButton = 'a[name="farm_town_overview"]';
      const selectAllButton = "div.game_header a.checkbox.select_all";
      const claimButton = "#fto_claim_button";

      await this.page.waitForSelector(captainButton, { visible: true });
      await humanDelay(1200, 2200);
      await this.page.hover(captainButton);

      await this.addLog("KAPITAN: Otwieram menu rolnicze...", "info");

      await this.page.waitForSelector(villagesButton, { visible: true });
      await humanDelay(900, 1600);
      await this.clickRandomPoint(villagesButton);

      try {
        await this.page.waitForSelector(selectAllButton, {
          visible: true,
          timeout: 4000,
        });
      } catch {
        await this.addLog(
          "Popup nie otworzył się — ponawiam klik",
          "warning"
        );
        await humanDelay(800, 1400);
        await this.clickRandomPoint(villagesButton);
        await this.page.waitForSelector(selectAllButton, {
          visible: true,
        });
      }

      await humanDelay(1500, 2500);
      await this.clickRandomPoint(selectAllButton);

      await humanDelay(1700, 2700);

      var claimDebug = await this.page.evaluate(function() {
        var btn = document.querySelector("#fto_claim_button");
        if (!btn) return { found: false, classes: "", text: "", disabled: true, visible: false };
        var el = btn as HTMLElement;
        return {
          found: true,
          classes: el.className || "",
          text: (el.textContent || "").trim().substring(0, 50),
          disabled: el.classList.contains("disabled"),
          visible: el.offsetParent !== null || el.offsetHeight > 0,
          tag: el.tagName,
          rect: JSON.stringify(el.getBoundingClientRect())
        };
      });

      await this.addLog(`Claim debug: found=${claimDebug.found} disabled=${claimDebug.disabled} visible=${claimDebug.visible} classes="${claimDebug.classes}" rect=${claimDebug.rect || "?"}`, "info");

      if (!claimDebug.found || claimDebug.disabled) {
        await this.addLog("Cooldown aktywny lub przycisk nie znaleziony — nie zbieram.", "warning");
        await this.closePopup();
        this.scheduleNextCollect();
        return;
      }

      await humanDelay(800, 1800);

      await this.addLog("Klikam ODBIERZ (metoda 1: mouse.click)...", "info");
      await this.clickRandomPoint(claimButton);

      await humanDelay(1000, 2000);

      var afterClick1 = await this.page.evaluate(function() {
        var btn = document.querySelector("#fto_claim_button");
        if (!btn) return { disabled: false, classes: "" };
        return { disabled: btn.classList.contains("disabled"), classes: (btn as HTMLElement).className || "" };
      });

      if (afterClick1.disabled) {
        await this.addLog("Zebrano surowce ze wszystkich wiosek (mouse.click).", "success");
        await this.closePopup();
        this.scheduleNextCollect();
        return;
      }

      await this.addLog("mouse.click nie zadziałał, próbuję CDP Input.dispatchMouseEvent...", "warning");

      try {
        var el2 = await this.page.$(claimButton);
        if (el2) {
          var box2 = await el2.boundingBox();
          if (box2) {
            var cx = box2.x + box2.width / 2 + randomBetween(-2, 2);
            var cy = box2.y + box2.height / 2 + randomBetween(-2, 2);

            var cdp = await this.page.target().createCDPSession();
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
            await humanDelay(100, 200);
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
            await humanDelay(50, 120);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
            await cdp.detach();
          }
        }
      } catch (cdpErr: any) {
        await this.addLog(`CDP błąd: ${cdpErr.message}`, "error");
      }

      await humanDelay(1000, 1500);

      var afterClick2 = await this.page.evaluate(function() {
        var btn = document.querySelector("#fto_claim_button");
        if (!btn) return { disabled: false, classes: "" };
        return { disabled: btn.classList.contains("disabled"), classes: (btn as HTMLElement).className || "" };
      });

      if (afterClick2.disabled) {
        await this.addLog("Zebrano surowce (CDP click).", "success");
        await this.closePopup();
        this.scheduleNextCollect();
        return;
      }

      await this.addLog("CDP nie zadziałał, próbuję page.click()...", "warning");

      try {
        await this.page.click(claimButton, { delay: randomBetween(50, 120) });
      } catch (clickErr: any) {
        await this.addLog(`page.click błąd: ${clickErr.message}`, "error");
      }

      await humanDelay(1000, 1500);

      var afterClick3 = await this.page.evaluate(function() {
        var btn = document.querySelector("#fto_claim_button");
        if (!btn) return { disabled: false, classes: "" };
        return { disabled: btn.classList.contains("disabled"), classes: (btn as HTMLElement).className || "" };
      });

      if (afterClick3.disabled) {
        await this.addLog("Zebrano surowce (page.click).", "success");
      } else {
        await this.addLog("ŻADNA metoda klikania nie zadziałała! Przycisk dalej aktywny.", "error");

        var pageDebug = await this.page.evaluate(function() {
          var btn = document.querySelector("#fto_claim_button");
          if (!btn) return "brak przycisku";
          var el = btn as HTMLElement;
          var parent = el.parentElement;
          var overlay = document.elementFromPoint(
            el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2,
            el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2
          );
          return "btn=" + el.tagName + "." + el.className +
            " parent=" + (parent ? parent.tagName + "." + parent.className.substring(0, 30) : "?") +
            " overlay=" + (overlay ? overlay.tagName + "." + (overlay.className || "").substring(0, 30) + "#" + (overlay.id || "") : "?");
        });
        await this.addLog(`Debug overlay: ${pageDebug}`, "info");
      }

      await this.closePopup();
      this.scheduleNextCollect();
    } catch (err: any) {
      log(`Błąd collect: ${err.message}`, "farm");
      await this.addLog(`Błąd: ${err.message}`, "error");
      this.scheduleNextCollect();
    }
  }

  private async scheduleNextCollect() {
    if (!this.farmRunning) return;

    const longBreak = this.checkLongBreak();
    if (longBreak) {
      const breakMin = (longBreak / 60000).toFixed(1);
      await this.addLog(
        `Długa przerwa (symulacja snu) na ${breakMin} min.`,
        "sleep"
      );
      this.nextActionAt = Date.now() + longBreak;
      await storage.updateFarmSettings({
        botState: "sleeping",
        nextActionSeconds: Math.round(longBreak / 1000),
        nextLongBreak: "Trwa...",
      });
      this.farmTimer = setTimeout(() => {
        storage.updateFarmSettings({ botState: "active" });
        this.addLog("Długa przerwa zakończona. Wznawianie pracy.", "warning");
        this.collect();
      }, longBreak);
      return;
    }

    const baseDelay = 10 * 60 * 1000;
    const extraDelay = this.getRandomExtraDelay();
    const totalDelay = baseDelay + extraDelay;
    const nextBreakMin = Math.round(
      (this.nextLongBreakAt - Date.now()) / 60000
    );

    this.nextActionAt = Date.now() + totalDelay;

    await storage.updateFarmSettings({
      botState: "active",
      nextActionSeconds: Math.round(totalDelay / 1000),
      lastCollectAgo: "Właśnie teraz",
      nextLongBreak: `Za ok. ${nextBreakMin} min`,
      randomDelay: `+${(extraDelay / 1000).toFixed(1)}s`,
    });

    log(
      `Następne zbiory za ${(totalDelay / 60000).toFixed(2)} min`,
      "farm"
    );
    this.farmTimer = setTimeout(() => this.collect(), totalDelay);
  }

  private startSyncLoop() {
    log("Synchronizacja miast co 30s", "sync");

    const syncLoop = async () => {
      try {
        const citiesData = await this.scrapeGameData();
        if (citiesData && citiesData.length > 0) {
          await storage.syncCities(citiesData);
          notifyDataUpdate();
          log(`Zsynchronizowano ${citiesData.length} miast (${citiesData.map(c => `${c.name}: W${c.wood}/K${c.stone}/S${c.silver}`).join(', ')})`, "sync");
        }
      } catch (err: any) {
        log(`Błąd synchronizacji: ${err.message}`, "sync");
      }
    };

    syncLoop();
    this.syncTimer = setInterval(syncLoop, 30000);
  }

  private async addBuildLog(message: string, type: string) {
    const now = new Date();
    const time = now.toLocaleTimeString("pl-PL", { hour12: false });
    await storage.addBuildLog({ time, type, message });
    log(`[BUILD] ${message}`, "build");
  }

  getBuilderStatus() {
    return {
      manualRunning: this.builderRunning && !this.builderAutoMode,
      autoRunning: this.builderRunning && this.builderAutoMode,
    };
  }

  async startManualBuild() {
    if (!this.page || this.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany." };
    }
    if (this.builderRunning) {
      return { success: false, error: "Builder już działa." };
    }

    this.builderRunning = true;
    this.builderAutoMode = false;
    await this.addBuildLog("Ręczna budowa uruchomiona — buduję z kolejki.", "success");
    this.manualBuildLoop();
    return { success: true };
  }

  async startAutoBuild() {
    if (!this.page || this.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany." };
    }
    if (this.builderRunning) {
      return { success: false, error: "Builder już działa." };
    }

    this.builderRunning = true;
    this.builderAutoMode = true;
    await this.addBuildLog("Autobudowa uruchomiona — buduję wg planu co 12-16 min.", "success");
    this.autoBuildLoop();
    return { success: true };
  }

  async stopBuilder() {
    this.builderRunning = false;
    this.builderAutoMode = false;
    if (this.buildTimer) {
      clearTimeout(this.buildTimer);
      clearInterval(this.buildTimer);
      this.buildTimer = null;
    }
    await this.addBuildLog("Builder zatrzymany.", "warning");
    return { success: true };
  }

  private async manualBuildLoop() {
    if (!this.builderRunning || this.builderAutoMode || !this.page) return;

    try {
      await this.syncBeforeBuild();
      const cities = await storage.getCities();
      let builtSomething = false;

      for (const city of cities) {
        if (!this.builderRunning || this.builderAutoMode) break;
        if (!city.gameId) continue;

        const queue = await storage.getBuildingQueue(city.id);
        const waiting = queue.filter((q: any) => q.status === "waiting");
        if (waiting.length === 0) continue;

        const task = waiting[0];
        const buildingKey = task.buildingKey || "main";
        await this.addBuildLog(`${city.name}: Buduję ${task.buildingName} Lvl ${task.toLevel}...`, "info");

        const result = await this.executeBuild(city.gameId, buildingKey, task.buildingName || buildingKey);

        if (result && result.success) {
          builtSomething = true;
          await this.addBuildLog(`${city.name}: Zlecono ${task.buildingName} Lvl ${task.toLevel}!`, "success");
          await storage.removeFromQueue(task.id);
        } else {
          await this.addBuildLog(`${city.name}: Nie można budować ${task.buildingName}: ${result?.error || 'brak przycisku'}`, "warning");
        }

        await humanDelay(2000, 5000);
      }

      if (!builtSomething) {
        await this.addBuildLog("Brak zadań w kolejce do budowy.", "info");
      }

      if (this.builderRunning && !this.builderAutoMode) {
        const nextDelay = builtSomething ? 10000 : 60000;
        this.buildTimer = setTimeout(() => this.manualBuildLoop(), nextDelay);
      }
    } catch (err: any) {
      await this.addBuildLog(`Błąd ręcznej budowy: ${err.message}`, "error");
      if (this.builderRunning && !this.builderAutoMode) {
        this.buildTimer = setTimeout(() => this.manualBuildLoop(), 30000);
      }
    }
  }

  private async syncBeforeBuild() {
    try {
      const citiesData = await this.scrapeGameData();
      if (citiesData && citiesData.length > 0) {
        await storage.syncCities(citiesData);
        notifyDataUpdate();
        await this.addBuildLog(`Zsynchronizowano ${citiesData.length} miast (kolejki budowy + surowce).`, "info");
      }
    } catch (err: any) {
      await this.addBuildLog(`Błąd sync przed budową: ${err.message}`, "error");
    }
  }

  private async autoBuildLoop() {
    if (!this.builderRunning || !this.builderAutoMode || !this.page) return;

    try {
      await this.syncBeforeBuild();
      const cities = await storage.getCities();
      let builtAnything = false;

      for (const city of cities) {
        if (!this.builderRunning || !this.builderAutoMode) break;
        if (!city.gameId) continue;

        const storageLevel = city.buildings?.storage || 0;
        const capacity = getStorageCapacity(storageLevel);
        const woodPct = (city.wood || 0) / capacity;
        const stonePct = (city.stone || 0) / capacity;
        const silverPct = (city.silver || 0) / capacity;

        if (woodPct < 0.5 || stonePct < 0.5 || silverPct < 0.5) {
          await this.addBuildLog(
            `${city.name}: Surowce <50% (D:${Math.round(woodPct*100)}% K:${Math.round(stonePct*100)}% S:${Math.round(silverPct*100)}%) — pomijam.`,
            "info"
          );
          continue;
        }

        const gameBuildQueue = city.buildQueue || [];
        const queueNames = gameBuildQueue.map((b: any) => b && b.building ? (this.BUILDING_NAMES_PL[b.building] || b.building) : '?');
        if (queueNames.length > 0) {
          await this.addBuildLog(`${city.name}: Kolejka (${queueNames.length}/7): ${queueNames.join(', ')}`, "info");
        } else {
          await this.addBuildLog(`${city.name}: Kolejka pusta (0/7)`, "info");
        }

        if (gameBuildQueue.length >= 7) {
          await this.addBuildLog(`${city.name}: Kolejka budowy w grze pełna (${gameBuildQueue.length}/7) — pomijam.`, "info");
          continue;
        }

        const buildingKey = this.getNextAutoBuildKey(city);
        if (!buildingKey) {
          await this.addBuildLog(`${city.name}: Plan ukończony.`, "success");
          continue;
        }

        const buildingNamePL = this.BUILDING_NAMES_PL[buildingKey] || buildingKey;
        await this.addBuildLog(`${city.name}: Auto-budowa ${buildingNamePL}...`, "info");

        const result = await this.executeBuild(city.gameId, buildingKey, buildingNamePL);
        if (result && result.success) {
          builtAnything = true;
          await this.addBuildLog(`${city.name}: Zlecono ${buildingNamePL}!`, "success");
        } else {
          await this.addBuildLog(`${city.name}: Nie można: ${result?.error || 'brak surowców'}`, "warning");
        }

        await humanDelay(2000, 5000);
      }

      if (!builtAnything) {
        await this.addBuildLog("Żadne miasto nie miało co budować.", "info");
      }

      if (this.builderRunning && this.builderAutoMode) {
        const delay = randomBetween(12 * 60 * 1000, 16 * 60 * 1000);
        await this.addBuildLog(`Następny cykl autobudowy za ${Math.round(delay / 60000)} min.`, "info");
        this.buildTimer = setTimeout(() => this.autoBuildLoop(), delay);
      }
    } catch (err: any) {
      await this.addBuildLog(`Błąd autobudowy: ${err.message}`, "error");
      if (this.builderRunning && this.builderAutoMode) {
        this.buildTimer = setTimeout(() => this.autoBuildLoop(), 60000);
      }
    }
  }

  private readonly BUILDING_NAMES_PL: Record<string, string> = {
    main: "Senat", lumber: "Obóz drwali", stoner: "Kamieniołom",
    ironer: "Kopalnia srebra", temple: "Świątynia", farm: "Gospodarstwo wiejskie",
    barracks: "Koszary", wall: "Mur miejski", storage: "Magazyn",
    docks: "Port", place: "Agora", academy: "Akademia", market: "Targowisko",
    hide: "Jaskinia", theater: "Teatr", thermal: "Łaźnie",
    library: "Biblioteka", lighthouse: "Latarnia morska", tower: "Wieża",
    statue: "Posąg boski", oracle: "Wyrocznia", trade_office: "Placówka handlowa",
  };

  private getNextAutoBuildKey(city: any): string | null {
    const BUILD_PLAN = [
      { key: "barracks", level: 5 }, { key: "academy", level: 13 },
      { key: "storage", level: 16 }, { key: "temple", level: 5 },
      { key: "market", level: 15 }, { key: "main", level: 25 },
      { key: "farm", level: 16 }, { key: "trade_office", level: 1 },
      { key: "storage", level: 21 }, { key: "farm", level: 20 },
      { key: "academy", level: 30 }, { key: "storage", level: 26 },
      { key: "market", level: 20 }, { key: "farm", level: 24 },
      { key: "storage", level: 30 }, { key: "hide", level: 10 },
      { key: "docks", level: 5 }, { key: "stoner", level: 25 },
      { key: "ironer", level: 27 }, { key: "lumber", level: 35 },
      { key: "ironer", level: 32 }, { key: "theater", level: 1 },
      { key: "market", level: 30 }, { key: "academy", level: 36 },
      { key: "stoner", level: 40 }, { key: "lumber", level: 40 },
      { key: "ironer", level: 40 }, { key: "docks", level: 20 },
      { key: "barracks", level: 20 }, { key: "temple", level: 30 },
      { key: "farm", level: 45 }, { key: "docks", level: 30 },
      { key: "barracks", level: 30 },
    ];

    const bq = city.buildQueue || [];

    for (const step of BUILD_PLAN) {
      const currentLevel = city.buildings?.[step.key] || 0;
      let queuedCount = 0;
      for (let qi = 0; qi < bq.length; qi++) {
        if (bq[qi] && bq[qi].building === step.key) queuedCount++;
      }
      const effectiveLevel = currentLevel + queuedCount;
      if (effectiveLevel < step.level) {
        return step.key;
      }
    }
    return null;
  }

  private async scrapeGameData() {
    if (!this.page) return [];
    return await this.page.evaluate(function() {
      var result: any[] = [];
      try {
        var towns = Object.values(ITowns.getTowns()) as any[];
        for (var ti = 0; ti < towns.length; ti++) {
          var town = towns[ti];
          var wood = 0, stone = 0, iron = 0;
          var buildings: any = {};
          var islandX = 0, islandY = 0, population = 0;

          try {
            var m = ITowns.getTown(town.id);
            if (m) {
              try {
                var r = m.resources();
                if (r) {
                  if (typeof r.get === 'function') {
                    wood = r.get('wood') || 0;
                    stone = r.get('stone') || 0;
                    iron = r.get('iron') || 0;
                  } else if (r.attributes) {
                    wood = r.attributes.wood || 0;
                    stone = r.attributes.stone || 0;
                    iron = r.attributes.iron || 0;
                  } else {
                    wood = r.wood || 0;
                    stone = r.stone || 0;
                    iron = r.iron || 0;
                  }
                }
              } catch(e) {}

              try {
                var b = m.buildings();
                if (b) {
                  if (b.attributes) {
                    buildings = Object.assign({}, b.attributes);
                  } else if (typeof b.get === 'function') {
                    var keys = ['main','hide','place','lumber','stoner','ironer','market','docks','barracks','wall','storage','farm','academy','temple','theater','thermal','library','lighthouse','tower','statue','oracle','trade_office'];
                    for (var ki = 0; ki < keys.length; ki++) {
                      try { buildings[keys[ki]] = b.get(keys[ki]) || 0; } catch(e) {}
                    }
                  } else {
                    buildings = Object.assign({}, b);
                  }
                  delete buildings.id;
                }
              } catch(e) {}

              try { islandX = m.getIslandCoordinateX() || 0; } catch(e) {}
              try { islandY = m.getIslandCoordinateY() || 0; } catch(e) {}
              try { population = m.getAvailablePopulation ? m.getAvailablePopulation() : 0; } catch(e) {}
            }
          } catch(e) {}

          var buildQueue: any[] = [];
          try {
            var ordersCollection = town.buildingOrders ? town.buildingOrders() : null;
            if (!ordersCollection && typeof town.getBuildingOrders === 'function') {
              ordersCollection = town.getBuildingOrders();
            }
            if (ordersCollection && ordersCollection.models) {
              var orderModels = ordersCollection.models;
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

          result.push({
            gameId: town.id,
            name: town.name,
            ocean: 'M' + Math.floor(islandX / 100) + '' + Math.floor(islandY / 100),
            wood: wood,
            stone: stone,
            silver: iron,
            population: population,
            buildings: buildings,
            buildQueue: buildQueue,
            islandX: islandX,
            islandY: islandY,
          });
        }
      } catch(e) {}
      return result;
    });
  }

  private async executeBuild(gameId: number, buildingKey: string, buildingName: string) {
    if (!this.page) return { success: false, error: "Brak strony" };

    try {
      const currentTownId = await this.page.evaluate(function() {
        try { return (window as any).Game?.townId || (window as any).ITowns?.getCurrentTown()?.id; } catch(e) { return 0; }
      });

      if (currentTownId && currentTownId !== gameId) {
        log(`Przełączam miasto z ${currentTownId} na ${gameId}`, "build");

        await this.closePopup();
        await humanDelay(500, 800);

        const switched = await this.page.evaluate(function(townId) {
          try {
            var wnd = window as any;
            var townModel = wnd.ITowns.getTown(townId);
            if (!townModel) return { ok: false, error: 'Nie znaleziono modelu miasta', needsSelect: false };

            if (typeof wnd.Game?.switchToTown === 'function') {
              wnd.Game.switchToTown(townId);
              return { ok: true, method: 'Game.switchToTown', needsSelect: false };
            }

            if (typeof townModel.switchToTown === 'function') {
              townModel.switchToTown();
              return { ok: true, method: 'townModel.switchToTown', needsSelect: false };
            }

            if (wnd.MM && wnd.MM.getControllers) {
              try {
                var ctrl = wnd.MM.getControllers();
                if (ctrl && ctrl.TownOverviewController && ctrl.TownOverviewController.switchToTown) {
                  ctrl.TownOverviewController.switchToTown(townId);
                  return { ok: true, method: 'TownOverviewController', needsSelect: false };
                }
              } catch(e) {}
            }

            var jumpTo = document.querySelector('.town_name_area .town_name') as HTMLElement;
            if (jumpTo) {
              jumpTo.click();
              return { ok: true, method: 'townNameClick', needsSelect: true };
            }

            return { ok: false, error: 'Brak metody przełączania', needsSelect: false };
          } catch (e) {
            return { ok: false, error: (e as any).message, needsSelect: false };
          }
        }, gameId);

        log(`Przełączanie: ${JSON.stringify(switched)}`, "build");

        if (switched?.needsSelect) {
          await humanDelay(800, 1200);
          const selectedFromList = await this.page.evaluate(function(townId) {
            try {
              var townLinks = document.querySelectorAll('.town_list .option, .town_group_town, .select_town');
              for (var li = 0; li < townLinks.length; li++) {
                var el = townLinks[li] as HTMLElement;
                var tid = el.getAttribute('data-town_id') || el.getAttribute('data-townid');
                if (tid && parseInt(tid) === townId) {
                  el.click();
                  return { ok: true };
                }
              }
              return { ok: false };
            } catch(e) { return { ok: false }; }
          }, gameId);
          log(`Wybór z listy: ${JSON.stringify(selectedFromList)}`, "build");
        }

        await humanDelay(2000, 3500);

        const newTownId = await this.page.evaluate(function() {
          try { return (window as any).Game?.townId || 0; } catch(e) { return 0; }
        });

        if (newTownId !== gameId) {
          log(`Fallback: klikam w link miasta na mapie`, "build");
          await this.page.evaluate(function(townId) {
            try {
              var url = '/game/index?town_id=' + townId;
              window.location.hash = '';
              var link = document.createElement('a');
              link.href = url;
              link.style.display = 'none';
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            } catch(e) {}
          }, gameId);
          await humanDelay(3000, 5000);

          const finalTownId = await this.page.evaluate(function() {
            try { return (window as any).Game?.townId || 0; } catch(e) { return 0; }
          });

          if (finalTownId !== gameId) {
            log(`Ostateczny fallback: przeładowanie strony z town_id`, "build");
            const currentUrl = await this.page.url();
            const baseUrl = currentUrl.split('?')[0].split('#')[0];
            await this.page.goto(`${baseUrl}?town_id=${gameId}`, { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForFunction(
              function() { return typeof ITowns !== "undefined" && Object.keys(ITowns.getTowns()).length > 0; },
              { timeout: 30000 }
            );
            await humanDelay(2000, 3000);
          }
        }

        log(`Aktualny town_id po przełączeniu: ${await this.page.evaluate(function() { return (window as any).Game?.townId; })}`, "build");
      }

      log(`Otwieram Senat...`, "build");
      await this.page.evaluate(function() {
        try {
          (window as any).BuildingWindowFactory.open('main');
        } catch(e) {}
      });
      await humanDelay(2000, 3000);

      const senateOpen = await this.page.evaluate(function() {
        return document.querySelectorAll('.button_build.build_up').length > 0;
      });

      if (!senateOpen) {
        log(`Senat się nie otworzył, próbuję ponownie...`, "build");
        await this.page.evaluate(function() {
          try {
            (window as any).BuildingWindowFactory.open('main');
          } catch(e) {}
        });
        await humanDelay(2500, 3500);
      }

      const buildResult = await this.page.evaluate(function(bName) {
        try {
          var bNameLower = bName.toLowerCase();
          var buildings = document.querySelectorAll('.building, .main_building');
          for (var bi = 0; bi < buildings.length; bi++) {
            var bldg = buildings[bi];
            var nameEl = bldg.querySelector('.name');
            if (!nameEl) continue;
            var name = nameEl.textContent?.trim() || '';
            if (!name.toLowerCase().includes(bNameLower)) continue;

            var btn = bldg.querySelector('a.button_build.build_up') as HTMLElement;
            if (!btn) {
              return { success: false, error: 'Znaleziono ' + bName + ' ale brak przycisku rozbudowy' };
            }

            var isDisabled = btn.classList.contains('disabled') || 
                               btn.classList.contains('not_possible') ||
                               btn.closest('.not_possible') !== null;

            if (isDisabled) {
              return { success: false, error: bName + ': brak surowców lub warunków (przycisk nieaktywny)' };
            }

            btn.click();
            return { success: true, clicked: name, buttonText: btn.textContent?.trim() };
          }

          var allNames: string[] = [];
          var nameEls = document.querySelectorAll('.name');
          for (var ni = 0; ni < nameEls.length; ni++) {
            var nt = nameEls[ni].textContent?.trim();
            if (nt) allNames.push(nt);
          }
          return { success: false, error: 'Nie znaleziono budynku "' + bName + '" w Senacie. Widoczne: ' + allNames.join(', ') };
        } catch (e) {
          return { success: false, error: (e as any).message };
        }
      }, buildingName);

      await humanDelay(500, 1000);

      await this.closePopup();

      return buildResult;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async startMarketBot() {
    if (!this.page || this.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany. Najpierw uruchom głównego bota." };
    }
    if (this.marketRunning) {
      return { success: false, error: "MarketBot już działa." };
    }

    this.marketRunning = true;
    await storage.updateMarketSettings({ isActive: true });
    await this.addMarketLog("MarketBot uruchomiony — rozpoczynam skanowanie giełdy.", "success");
    log("MarketBot uruchomiony", "market");

    this.marketScanLoop();
    return { success: true };
  }

  async stopMarketBot() {
    this.marketRunning = false;
    if (this.marketTimer) {
      clearTimeout(this.marketTimer);
      this.marketTimer = null;
    }
    await storage.updateMarketSettings({ isActive: false });
    await this.addMarketLog("MarketBot zatrzymany.", "warning");
    log("MarketBot zatrzymany", "market");
    return { success: true };
  }

  private async marketScanLoop() {
    if (!this.marketRunning || !this.page) return;

    try {
      const settings = await storage.getMarketSettings();
      if (!settings || !settings.isActive) {
        this.marketRunning = false;
        return;
      }

      const marketCities = await storage.getMarketCities();
      const enabledCityIds = marketCities.filter((mc: any) => mc.enabled).map((mc: any) => mc.cityId);

      if (enabledCityIds.length === 0) {
        await this.addMarketLog("Brak wybranych miast do handlu. Zaznacz miasta w panelu.", "warning");
      } else {
        const allCities = await storage.getCities();
        const citiesToProcess = allCities.filter((c: any) => enabledCityIds.includes(c.id));

        for (const city of citiesToProcess) {
          if (!this.marketRunning) break;

          const marketLevel = city.buildings?.market || 0;
          if (marketLevel < 1) {
            await this.addMarketLog(`${city.name}: brak Targowiska (level 0) — pomijam.`, "warning");
            continue;
          }

          const maxPerTransaction = marketLevel * 500;
          await this.addMarketLog(`Skanuję giełdę dla ${city.name} (Targowisko Lvl ${marketLevel}, max ${maxPerTransaction}/transakcja)...`, "info");

          try {
            await this.closePopup();
            await humanDelay(500, 1000);
            await this.switchToCity(city.gameId);
            await humanDelay(2000, 3000);

            const sellResult = await this.executeMarketSell(city, settings, maxPerTransaction);

            if (sellResult.sold) {
              const parts = [];
              if (sellResult.woodSold > 0) parts.push(`Drewno: ${sellResult.woodSold}`);
              if (sellResult.stoneSold > 0) parts.push(`Kamień: ${sellResult.stoneSold}`);
              if (sellResult.silverSold > 0) parts.push(`Srebro: ${sellResult.silverSold}`);
              await this.addMarketLog(`${city.name}: Sprzedano na giełdzie — ${parts.join(", ")}`, "success");
            } else if (sellResult.reason) {
              await this.addMarketLog(`${city.name}: ${sellResult.reason}`, "info");
            }

            await this.closePopup();
          } catch (err: any) {
            await this.addMarketLog(`${city.name}: Błąd — ${err.message}`, "error");
            log(`Market error for ${city.name}: ${err.message}`, "market");
            await this.closePopup();
          }

          await humanDelay(3000, 5000);
        }
      }

      const scanDelays: Record<string, number> = {
        aggressive: 3000,
        standard: 10000,
        safe: 30000,
      };
      const settings2 = await storage.getMarketSettings();
      const delay = scanDelays[settings2?.scanFrequency || "standard"] || 10000;
      const jitter = randomBetween(0, Math.floor(delay * 0.3));

      this.marketTimer = setTimeout(() => this.marketScanLoop(), delay + jitter);
    } catch (err: any) {
      await this.addMarketLog(`Błąd pętli skanowania: ${err.message}`, "error");
      log(`Market scan loop error: ${err.message}`, "market");
      this.marketTimer = setTimeout(() => this.marketScanLoop(), 15000);
    }
  }

  private async executeMarketSell(city: any, settings: any, maxPerTransaction: number) {
    if (!this.page) return { sold: false, reason: "Brak strony" };

    if (!this.marketRunning) return { sold: false, reason: "MarketBot zatrzymany." };
    await this.addMarketLog(`${city.name}: Otwieram Targowisko...`, "info");

    await this.page.evaluate(function() {
      try {
        var wnd = window as any;
        if (wnd.BuildingWindowFactory) {
          wnd.BuildingWindowFactory.open('market');
        }
      } catch(e) {}
    });
    await humanDelay(2000, 3000);

    const windowInfo = await this.page.evaluate(function() {
      var wndMgr = (window as any).GPWindowMgr || (window as any).WindowManager;
      var openWindows: string[] = [];
      if (wndMgr && wndMgr.getOpen) {
        try {
          var wins = wndMgr.getOpen();
          for (var wi = 0; wi < wins.length; wi++) {
            try { openWindows.push(wins[wi].getTitle ? wins[wi].getTitle() : 'unknown'); } catch(e) {}
          }
        } catch(e) {}
      }
      var allTabs = document.querySelectorAll('.gpwnd_tab, .tab_type, [class*="page-caption"], .submenu_link, .nui_tab');
      var tabTexts: string[] = [];
      for (var ti = 0; ti < allTabs.length; ti++) {
        var txt = (allTabs[ti] as HTMLElement).textContent?.trim();
        if (txt) tabTexts.push(txt);
      }
      return { openWindows: openWindows, tabTexts: tabTexts };
    });
    await this.addMarketLog(`${city.name}: Okna: [${windowInfo.openWindows.join(', ')}], Zakładki: [${windowInfo.tabTexts.join(', ')}]`, "info");

    const clickedGielda = await this.page.evaluate(function() {
      var selectors = ['.submenu_link', '.gpwnd_tab', '.tab_type', '[class*="page-caption"]', '.nui_tab', 'a, div, span, li'];
      for (var si = 0; si < selectors.length; si++) {
        var elements = document.querySelectorAll(selectors[si]);
        for (var ei = 0; ei < elements.length; ei++) {
          var text = (elements[ei] as HTMLElement).textContent?.trim() || '';
          if (text === 'Giełda' || text === 'Gielda') {
            (elements[ei] as HTMLElement).click();
            return { clicked: true, text: text, tag: elements[ei].tagName, class: elements[ei].className };
          }
        }
      }
      return { clicked: false, text: '', tag: '', class: '' };
    });
    await this.addMarketLog(`${city.name}: Klik "Giełda": ${clickedGielda.clicked ? 'TAK (' + clickedGielda.tag + '.' + clickedGielda.class + ')' : 'NIE ZNALEZIONO'}`, "info");
    if (clickedGielda.clicked) await humanDelay(1500, 2500);

    const clickedSellTab = await this.page.evaluate(function() {
      var selectors = ['a', 'div', 'span', 'button', 'li', 'label'];
      for (var si = 0; si < selectors.length; si++) {
        var elements = document.querySelectorAll(selectors[si]);
        for (var ei = 0; ei < elements.length; ei++) {
          var text = (elements[ei] as HTMLElement).textContent?.trim() || '';
          if (text === 'Sprzedaj surowce') {
            (elements[ei] as HTMLElement).click();
            return { clicked: true, tag: elements[ei].tagName, class: elements[ei].className };
          }
        }
      }
      return { clicked: false, tag: '', class: '' };
    });
    await this.addMarketLog(`${city.name}: Klik "Sprzedaj surowce": ${clickedSellTab.clicked ? 'TAK (' + clickedSellTab.tag + ')' : 'NIE ZNALEZIONO'}`, clickedSellTab.clicked ? "info" : "warning");
    await humanDelay(1500, 2500);

    const exchangeData = await this.page.evaluate(function() {
      try {
        var types = ['wood', 'stone', 'iron'];
        var names = ['Drewno', 'Kamień', 'Srebro'];
        var resources: any[] = [];

        for (var ti = 0; ti < types.length; ti++) {
          var spinner = document.querySelector('.spinner_horizontal[data-type="' + types[ti] + '"]');
          if (!spinner) continue;

          var current = 0;
          var max = 0;
          var found = false;

          var container = spinner.parentElement;
          while (container && !found) {
            var curEl = container.querySelector('.current');
            var maxEl = container.querySelector('.max');
            if (curEl && maxEl) {
              current = parseInt((curEl.textContent || '0').replace(/[\s.,]/g, ''));
              max = parseInt((maxEl.textContent || '0').replace(/[\s.,]/g, ''));
              if (max > 0) found = true;
            }
            container = container.parentElement;
          }

          if (!found) {
            var prev = spinner.previousElementSibling;
            while (prev) {
              var curEl2 = prev.querySelector('.current');
              var maxEl2 = prev.querySelector('.max');
              if (curEl2 && maxEl2) {
                current = parseInt((curEl2.textContent || '0').replace(/[\s.,]/g, ''));
                max = parseInt((maxEl2.textContent || '0').replace(/[\s.,]/g, ''));
                if (max > 0) found = true;
                break;
              }
              prev = prev.previousElementSibling;
            }
          }

          resources.push({
            type: types[ti],
            name: names[ti],
            current: current,
            max: max,
            free: max - current,
            found: found
          });
        }

        return { ok: true, resources: resources };
      } catch (e) {
        return { ok: false, resources: [], error: (e as any).message };
      }
    });

    if (!exchangeData.ok || exchangeData.resources.length === 0) {
      await this.closePopup();
      return { sold: false, reason: `Nie odczytano danych giełdy: ${exchangeData.error || 'brak spinnerów'}` };
    }

    const resInfo = exchangeData.resources.map((r: any) => `${r.name}: ${r.current}/${r.max} (wolne=${r.free})`).join(', ');
    await this.addMarketLog(`${city.name}: Giełda — ${resInfo}`, "info");

    const availableWood = Math.max(0, (city.wood || 0) - (settings.minWood || 5000));
    const availableStone = Math.max(0, (city.stone || 0) - (settings.minStone || 5000));
    const availableSilver = Math.max(0, (city.silver || 0) - (settings.minSilver || 5000));

    const candidates = [
      { type: 'wood', dataType: 'wood', name: 'Drewno', available: availableWood, exchangeFree: 0 },
      { type: 'stone', dataType: 'stone', name: 'Kamień', available: availableStone, exchangeFree: 0 },
      { type: 'silver', dataType: 'iron', name: 'Srebro', available: availableSilver, exchangeFree: 0 },
    ];

    for (const c of candidates) {
      const exRes = exchangeData.resources.find((r: any) => r.type === c.dataType);
      if (exRes) c.exchangeFree = exRes.free;
    }

    let bestCandidate = null;
    let bestClicks = 0;

    for (const c of candidates) {
      if (c.available < 500 || c.exchangeFree < 500) continue;
      const clicks = Math.min(Math.floor(c.available / 500), Math.floor(c.exchangeFree / 500));
      if (clicks > bestClicks) {
        bestClicks = clicks;
        bestCandidate = c;
      }
    }

    if (!bestCandidate || bestClicks <= 0) {
      const reason = candidates.map(c => `${c.name}: dostępne=${c.available}, wolne_na_giełdzie=${c.exchangeFree}`).join('; ');
      await this.closePopup();
      return { sold: false, reason: `Nie ma co sprzedawać — ${reason}` };
    }

    const totalToSell = bestClicks * 500;
    await this.addMarketLog(`${city.name}: Sprzedaję ${bestCandidate.name} — ${totalToSell} (wolne na giełdzie=${bestCandidate.exchangeFree})...`, "info");

    if (!this.marketRunning) return { sold: false, reason: "MarketBot zatrzymany." };

    const clickDataType = bestCandidate.dataType;

    const spinnerInfo = await this.page.evaluate(function(dt) {
      var spinner = document.querySelector('.spinner_horizontal[data-type="' + dt + '"]') as HTMLElement;
      if (!spinner) return { found: false };

      var rect = spinner.getBoundingClientRect();
      var increaseBtn = spinner.querySelector('.button_increase') as HTMLElement;
      var btnRect = increaseBtn ? increaseBtn.getBoundingClientRect() : null;

      var bodyEl = spinner.querySelector('.body') as HTMLElement;
      var bodyRect = bodyEl ? bodyEl.getBoundingClientRect() : null;

      return {
        found: true,
        spinnerX: rect.left,
        spinnerY: rect.top,
        spinnerW: rect.width,
        spinnerH: rect.height,
        btnW: btnRect ? btnRect.width : -1,
        btnH: btnRect ? btnRect.height : -1,
        btnLeft: btnRect ? btnRect.left : -1,
        btnTop: btnRect ? btnRect.top : -1,
        bodyW: bodyRect ? bodyRect.width : -1,
        bodyH: bodyRect ? bodyRect.height : -1,
        bodyLeft: bodyRect ? bodyRect.left : -1,
        bodyTop: bodyRect ? bodyRect.top : -1
      };
    }, clickDataType);

    await this.addMarketLog(`${city.name}: Spinner ${bestCandidate.name}: ${JSON.stringify(spinnerInfo)}`, "info");

    if (!spinnerInfo.found) {
      await this.closePopup();
      return { sold: false, reason: `Spinner dla ${bestCandidate.name} nie znaleziony.` };
    }

    const clickX = spinnerInfo.spinnerX + spinnerInfo.spinnerW - 5;
    const clickY = spinnerInfo.spinnerY + (spinnerInfo.spinnerH / 2);

    await this.addMarketLog(`${city.name}: Klikam strzałkę + przez mouse.click(${Math.round(clickX)}, ${Math.round(clickY)}) x${bestClicks}...`, "info");

    for (let ci = 0; ci < bestClicks; ci++) {
      await this.page.mouse.click(clickX, clickY);
      await humanDelay(400, 700);
    }

    await humanDelay(600, 1000);

    const filledValue = await this.page.evaluate(function(dt) {
      var input = document.querySelector('.spinner_horizontal[data-type="' + dt + '"] input') as HTMLInputElement;
      return input ? input.value : '';
    }, clickDataType);
    await this.addMarketLog(`${city.name}: Po kliknięciu koordynatami — wartość ${bestCandidate.name} = "${filledValue}"`, "info");

    if (!filledValue || filledValue === '0' || filledValue === '') {
      await this.addMarketLog(`${city.name}: Koordynaty nie zadziałały, próbuję wpisać ręcznie do inputa...`, "warning");

      await this.page.evaluate(function(dt, amount) {
        var spinner = document.querySelector('.spinner_horizontal[data-type="' + dt + '"]') as HTMLElement;
        if (!spinner) return;
        var input = spinner.querySelector('input') as HTMLInputElement;
        if (!input) return;

        input.focus();
        input.value = '';

        var nativeSetter = Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(input, amount.toString());
        } else {
          input.value = amount.toString();
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0', keyCode: 48 }));

        var jq = (window as any).$ || (window as any).jQuery;
        if (jq) {
          jq(input).trigger('sp_change');
          jq(input).trigger('spinner:change');
          jq(input).trigger('spinner:change:value');
        }
      }, clickDataType, totalToSell);

      await humanDelay(400, 600);

      const filledValue2 = await this.page.evaluate(function(dt) {
        var input = document.querySelector('.spinner_horizontal[data-type="' + dt + '"] input') as HTMLInputElement;
        return input ? input.value : '';
      }, clickDataType);
      await this.addMarketLog(`${city.name}: Po ręcznym wpisaniu — wartość = "${filledValue2}"`, "info");

      if (!filledValue2 || filledValue2 === '0' || filledValue2 === '') {
        await this.closePopup();
        return { sold: false, reason: `Nie udało się ustawić wartości spinnera ${bestCandidate.name}.` };
      }
    }

    await humanDelay(500, 1000);

    if (!this.marketRunning) { await this.closePopup(); return { sold: false, reason: "MarketBot zatrzymany." }; }

    await this.addMarketLog(`${city.name}: Klikam "Znajdź najlepsze kursy wymiany"...`, "info");

    const findRatesInfo = await this.page.evaluate(function() {
      var btn = document.querySelector('.btn_find_rates') as HTMLElement;
      if (!btn) return { found: false };
      var rect = btn.getBoundingClientRect();
      return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
    });

    if (findRatesInfo.found) {
      await this.page.mouse.click(findRatesInfo.x, findRatesInfo.y);
    }

    await humanDelay(2500, 4000);

    if (!this.marketRunning) { await this.closePopup(); return { sold: false, reason: "MarketBot zatrzymany." }; }

    await this.addMarketLog(`${city.name}: Klikam "Potwierdź zamówienie"...`, "info");
    const confirmInfo = await this.page.evaluate(function() {
      var btn = document.querySelector('.btn_confirm') as HTMLElement;
      if (!btn) return { found: false };
      var rect = btn.getBoundingClientRect();
      return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
    });

    if (confirmInfo.found) {
      await this.page.mouse.click(confirmInfo.x, confirmInfo.y);
    }

    await humanDelay(2000, 3000);
    await this.closePopup();

    await this.addMarketLog(`${city.name}: Sprzedano ${bestCandidate.name}: ${totalToSell}!`, "success");

    return {
      sold: true,
      woodSold: bestCandidate.type === 'wood' ? totalToSell : 0,
      stoneSold: bestCandidate.type === 'stone' ? totalToSell : 0,
      silverSold: bestCandidate.type === 'silver' ? totalToSell : 0,
    };
  }

  // ===== CULTURE BOT (delegated to CultureBot class in Resorce queue/) =====

  private ensureCultureBot(): CultureBot {
    if (!this.cultureBot) {
      const core = new BotCore();
      core.page = this.page;
      core.browser = this.browser;
      core.status = this.status;
      this.cultureBot = new CultureBot(core);
    } else {
      this.cultureBot["core"].page = this.page;
      this.cultureBot["core"].browser = this.browser;
      this.cultureBot["core"].status = this.status;
    }
    return this.cultureBot;
  }

  getCultureStatus() {
    const now = Date.now();
    const nextActions: Record<string, number> = {};
    const events = ["festival", "games", "triumph", "theater"];
    const bot = this.cultureBot;
    for (const key of events) {
      const at = bot ? bot.getNextActionAt(key) : 0;
      nextActions[key] = at > now ? Math.round((at - now) / 1000) : 0;
    }
    return {
      running: !!bot && (bot.isEventRunning('festival') || bot.isEventRunning('games') || bot.isEventRunning('triumph') || bot.isEventRunning('theater')),
      nextActions,
    };
  }

  async startCultureBot() {
    if (!this.page || this.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany." };
    }

    const bot = this.ensureCultureBot();
    const settings = await storage.getCultureSettings();
    await storage.updateCultureSettings({ isActive: true });

    const events = ["festival", "games", "triumph", "theater"];
    for (const eventKey of events) {
      const eventSettings = settings[eventKey];
      if (eventSettings?.enabled) {
        await bot.startEvent(eventKey);
      }
    }

    return { success: true };
  }

  async stopCultureBot() {
    if (this.cultureBot) {
      this.cultureBot.stopAll();
    }
    await storage.updateCultureSettings({ isActive: false });
    return { success: true };
  }

  private async switchToCity(gameId: number) {
    if (!this.page) return;

    const currentTownId = await this.page.evaluate(function() {
      try { return (window as any).Game?.townId || (window as any).ITowns?.getCurrentTown()?.id; } catch(e) { return 0; }
    });

    await this.addMarketLog(`Przełączanie: aktualne miasto=${currentTownId}, docelowe=${gameId}`, "info");

    if (currentTownId === gameId) {
      await this.addMarketLog(`Już jestem w mieście ${gameId} — nie przełączam.`, "info");
      return;
    }

    log(`Market: przełączam miasto na ${gameId}`, "market");

    await this.addMarketLog(`Zamykam okna gry przed przełączeniem...`, "info");
    await this.page.evaluate(function() {
      try {
        var closeBtns = document.querySelectorAll('.btn_wnd.close');
        for (var i = 0; i < closeBtns.length; i++) {
          try { (closeBtns[i] as HTMLElement).click(); } catch(e) {}
        }
      } catch(e) {}
    });
    await this.closePopup();
    await humanDelay(800, 1200);

    // Metoda 1: Taka sama jak w BuilderBocie
    const switched = await this.page.evaluate(function(townId) {
      try {
        var wnd = window as any;
        var townModel = wnd.ITowns.getTown(townId);
        if (!townModel) return { ok: false, error: 'Nie znaleziono modelu miasta', method: 'none', needsSelect: false };

        if (typeof wnd.Game?.switchToTown === 'function') {
          wnd.Game.switchToTown(townId);
          return { ok: true, method: 'Game.switchToTown', needsSelect: false };
        }

        if (typeof townModel.switchToTown === 'function') {
          townModel.switchToTown();
          return { ok: true, method: 'townModel.switchToTown', needsSelect: false };
        }

        if (wnd.MM && wnd.MM.getControllers) {
          try {
            var ctrl = wnd.MM.getControllers();
            if (ctrl && ctrl.TownOverviewController && ctrl.TownOverviewController.switchToTown) {
              ctrl.TownOverviewController.switchToTown(townId);
              return { ok: true, method: 'TownOverviewController', needsSelect: false };
            }
          } catch(e) {}
        }

        var jumpTo = document.querySelector('.town_name_area .town_name') as HTMLElement;
        if (jumpTo) {
          jumpTo.click();
          return { ok: true, method: 'townNameClick', needsSelect: true };
        }

        return { ok: false, error: 'Brak metody przełączania', method: 'none', needsSelect: false };
      } catch (e) {
        return { ok: false, error: (e as any).message, method: 'error', needsSelect: false };
      }
    }, gameId);

    await this.addMarketLog(`Przełączanie na ${gameId}: metoda="${switched.method}", sukces=${switched.ok}`, "info");

    // Obsługa listy miast (jak w BuilderBocie)
    if (switched?.needsSelect) {
      await humanDelay(800, 1200);
      const selectedFromList = await this.page.evaluate(function(townId) {
        try {
          var townLinks = document.querySelectorAll('.town_list .option, .town_group_town, .select_town');
          for (var li = 0; li < townLinks.length; li++) {
            var el = townLinks[li] as HTMLElement;
            var tid = el.getAttribute('data-town_id') || el.getAttribute('data-townid');
            if (tid && parseInt(tid) === townId) {
              el.click();
              return { ok: true };
            }
          }
          return { ok: false };
        } catch(e) { return { ok: false }; }
      }, gameId);
      await this.addMarketLog(`Wybór z listy miast: ${selectedFromList?.ok ? 'OK' : 'NIE ZNALEZIONO'}`, "info");
    }

    await humanDelay(2000, 3500);

    // Sprawdź czy się przełączyło
    const newTownId = await this.page.evaluate(function() {
      try { return (window as any).Game?.townId || 0; } catch(e) { return 0; }
    });

    if (newTownId !== gameId) {
      // Fallback 1: link z town_id (jak BuilderBot)
      await this.addMarketLog(`Fallback: tworzę link z town_id=${gameId}...`, "warning");
      await this.page.evaluate(function(townId) {
        try {
          var url = '/game/index?town_id=' + townId;
          window.location.hash = '';
          var link = document.createElement('a');
          link.href = url;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } catch(e) {}
      }, gameId);
      await humanDelay(3000, 5000);

      const fallbackTownId = await this.page.evaluate(function() {
        try { return (window as any).Game?.townId || 0; } catch(e) { return 0; }
      });

      if (fallbackTownId !== gameId) {
        // Fallback 2: przeładowanie strony (jak BuilderBot)
        await this.addMarketLog(`Ostateczny fallback: przeładowanie strony z town_id=${gameId}`, "warning");
        const currentUrl = await this.page.url();
        const baseUrl = currentUrl.split('?')[0].split('#')[0];
        await this.page.goto(`${baseUrl}?town_id=${gameId}`, { waitUntil: 'networkidle2', timeout: 30000 });
        await this.page.waitForFunction(
          function() { return typeof ITowns !== "undefined" && Object.keys(ITowns.getTowns()).length > 0; },
          { timeout: 30000 }
        );
        await humanDelay(2000, 3000);
      }
    }

    const finalTownId = await this.page.evaluate(function() {
      try { return (window as any).Game?.townId || (window as any).ITowns?.getCurrentTown()?.id; } catch(e) { return 0; }
    });
    await this.addMarketLog(`Po przełączeniu: aktualne miasto=${finalTownId} (oczekiwane=${gameId}) ${finalTownId === gameId ? 'OK' : 'BLAD'}`, finalTownId === gameId ? "info" : "error");
  }

  private async addMarketLog(message: string, type: string) {
    const now = new Date();
    const time = now.toLocaleTimeString("pl-PL", { hour12: false });
    await storage.addMarketLog({ time, type, message });
  }

  private async clickRandomPoint(selector: string) {
    const element = await this.page.$(selector);
    if (!element) return;
    const box = await element.boundingBox();
    if (!box) {
      await this.page.click(selector);
      return;
    }
    const mx = box.width * 0.15;
    const my = box.height * 0.15;
    const x = randomBetween(box.x + mx, box.x + box.width - mx);
    const y = randomBetween(box.y + my, box.y + box.height - my);
    try {
      await this.page.mouse.click(x, y);
    } catch {
      await this.page.click(selector);
    }
  }

  private async closePopup() {
    try {
      await this.page.evaluate(function() {
        var closeBtns = document.querySelectorAll('.btn_wnd.close');
        for (var i = 0; i < closeBtns.length; i++) {
          try { (closeBtns[i] as HTMLElement).click(); } catch(e) {}
        }
        var uiClose = document.querySelector(".ui-dialog-titlebar-close");
        if (uiClose) (uiClose as any).click();
      });
    } catch {}
  }

  private generateNextLongBreakTime() {
    return Date.now() + randomBetween(3 * 3600000, 6 * 3600000);
  }

  private checkLongBreak() {
    if (Date.now() >= this.nextLongBreakAt) {
      const roll = Math.random();
      let dur: number;
      if (roll < 0.6) dur = randomBetween(30 * 60000, 60 * 60000);
      else if (roll < 0.9) dur = randomBetween(60 * 60000, 120 * 60000);
      else dur = randomBetween(2 * 3600000, 4 * 3600000);
      this.nextLongBreakAt = this.generateNextLongBreakTime();
      return dur;
    }
    return null;
  }

  private getRandomExtraDelay() {
    const roll = Math.random();
    if (roll < 0.7) return randomBetween(5000, 120000);
    if (roll < 0.9) return randomBetween(121000, 360000);
    return randomBetween(600000, 840000);
  }

  private async addLog(message: string, type: string) {
    const now = new Date();
    const time = now.toLocaleTimeString("pl-PL", { hour12: false });
    await storage.addFarmLog({ time, type, message });
  }
}

export const botManager = new BotManager();