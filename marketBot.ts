import { storage } from "../storage";
import { BotCore } from "./core";

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function humanDelay(min = 800, max = 2000) {
  const delay = randomBetween(min, max);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export class MarketBot {

  private marketRunning = false;
  private marketTimer: any = null;
  private marketWindowOpen = false;

  constructor(private core: BotCore) {}

  get isRunning() {
    return this.marketRunning;
  }

  private async addLog(message: string, type: string) {
    const now = new Date();
    const time = now.toLocaleTimeString("pl-PL", { hour12: false });
    await storage.addMarketLog({ time, type, message });
  }

  async start() {
    if (!this.core.page || this.core.status !== "active") {
      return { success: false, error: "Bot nie jest zalogowany." };
    }
    if (this.marketRunning) {
      return { success: false, error: "MarketBot już działa." };
    }

    this.marketRunning = true;
    this.marketWindowOpen = false;
    await storage.updateMarketSettings({ isActive: true });
    await this.addLog("MarketBot uruchomiony — rozpoczynam skanowanie giełdy.", "success");
    this.marketScanLoop();
    return { success: true };
  }

  async stop() {
    this.marketRunning = false;
    this.marketWindowOpen = false;
    if (this.marketTimer) {
      clearTimeout(this.marketTimer);
      this.marketTimer = null;
    }
    await storage.updateMarketSettings({ isActive: false });
    await this.closePopup();
    await this.addLog("MarketBot zatrzymany.", "warning");
    return { success: true };
  }

  private async openMarketOnce() {
    var page = this.core.page;
    if (!page) return false;

    var alreadyOpen = await page.evaluate(function() {
      var sellTab = document.querySelector('.gp_tab_page.active[data-type="sell"] .spinner_horizontal[data-type="wood"]');
      if (sellTab) return 'sell_open';

      var marketWnd = document.querySelector('#premium_exchange');
      if (marketWnd) return 'market_open';

      return 'closed';
    });

    if (alreadyOpen === 'sell_open') {
      await this.addLog("Targowisko już otwarte na zakładce 'Sprzedaj surowce'.", "info");
      this.marketWindowOpen = true;
      return true;
    }

    if (alreadyOpen === 'market_open') {
      await this.addLog("Targowisko otwarte — przechodzę do 'Sprzedaj surowce'...", "info");
      await this.clickSellTab(page);
      this.marketWindowOpen = true;
      return true;
    }

    await this.addLog("Otwieram Targowisko...", "info");

    await page.evaluate(function() {
      try {
        var wnd = window as any;
        if (wnd.BuildingWindowFactory) {
          wnd.BuildingWindowFactory.open('market');
        }
      } catch(e) {}
    });
    await humanDelay(2000, 3000);

    var windowInfo = await page.evaluate(function() {
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
    await this.addLog(`Okna: [${windowInfo.openWindows.join(', ')}], Zakładki: [${windowInfo.tabTexts.join(', ')}]`, "info");

    var clickedGielda = await page.evaluate(function() {
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
    await this.addLog(`Klik "Giełda": ${clickedGielda.clicked ? 'TAK (' + clickedGielda.tag + '.' + clickedGielda.class + ')' : 'NIE ZNALEZIONO'}`, "info");
    if (clickedGielda.clicked) await humanDelay(1500, 2500);

    await this.clickSellTab(page);

    this.marketWindowOpen = true;
    return true;
  }

  private async clickSellTab(page: any) {
    var clickedSellTab = await page.evaluate(function() {
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
    await this.addLog(`Klik "Sprzedaj surowce": ${clickedSellTab.clicked ? 'TAK (' + clickedSellTab.tag + ')' : 'NIE ZNALEZIONO'}`, clickedSellTab.clicked ? "info" : "warning");
    await humanDelay(1500, 2500);
  }

  private async marketScanLoop() {
    if (!this.marketRunning || !this.core.page) return;

    try {
      var settings = await storage.getMarketSettings();
      if (!settings || !settings.isActive) {
        this.marketRunning = false;
        return;
      }

      var marketCities = await storage.getMarketCities();
      var enabledCityIds = marketCities.filter(function(mc: any) { return mc.enabled; }).map(function(mc: any) { return mc.cityId; });

      if (enabledCityIds.length === 0) {
        await this.addLog("Brak wybranych miast do handlu. Zaznacz miasta w panelu.", "warning");
      } else {
        var allCities = await storage.getCities();
        var citiesToProcess = allCities.filter(function(c: any) { return enabledCityIds.indexOf(c.id) !== -1; });

        if (!this.marketWindowOpen) {
          var opened = await this.openMarketOnce();
          if (!opened) {
            await this.addLog("Nie udało się otworzyć Targowiska.", "error");
            this.marketTimer = setTimeout(() => this.marketScanLoop(), 15000);
            return;
          }
        }

        var soldAnything = false;

        for (var ci = 0; ci < citiesToProcess.length; ci++) {
          var city = citiesToProcess[ci];
          if (!this.marketRunning) break;

          var marketLevel = city.buildings?.market || 0;
          if (marketLevel < 1) {
            await this.addLog(`${city.name}: brak Targowiska (level 0) — pomijam.`, "warning");
            continue;
          }

          var maxPerTransaction = marketLevel * 500;
          await this.addLog(`Skanuję giełdę dla ${city.name} (Targowisko Lvl ${marketLevel}, max ${maxPerTransaction}/transakcja)...`, "info");

          try {
            await this.switchToCityKeepWindow(city.gameId);
            await humanDelay(2000, 3000);

            var isStillOpen = await this.core.page!.evaluate(function() {
              var sellTab = document.querySelector('.gp_tab_page.active[data-type="sell"] .spinner_horizontal[data-type="wood"]');
              return !!sellTab;
            });

            if (!isStillOpen) {
              await this.addLog("Okno Targowiska zamknęło się — otwieram ponownie...", "warning");
              this.marketWindowOpen = false;
              var reopened = await this.openMarketOnce();
              if (!reopened) {
                await this.addLog("Nie udało się ponownie otworzyć Targowiska.", "error");
                continue;
              }
            }

            var sellResult = await this.trySellingInCurrentCity(city, settings, maxPerTransaction);

            if (sellResult.sold) {
              soldAnything = true;
              var parts: string[] = [];
              if (sellResult.woodSold > 0) parts.push('Drewno: ' + sellResult.woodSold);
              if (sellResult.stoneSold > 0) parts.push('Kamień: ' + sellResult.stoneSold);
              if (sellResult.silverSold > 0) parts.push('Srebro: ' + sellResult.silverSold);
              await this.addLog(`${city.name}: Sprzedano na giełdzie — ${parts.join(", ")}`, "success");
            } else if (sellResult.reason) {
              await this.addLog(`${city.name}: ${sellResult.reason}`, "info");
            }

          } catch (err: any) {
            await this.addLog(`${city.name}: Błąd — ${err.message}`, "error");
            this.marketWindowOpen = false;
          }

          await humanDelay(2000, 4000);
        }

        if (!soldAnything && this.marketRunning) {
          await this.addLog("Żadne miasto nie miało co sprzedać w tym cyklu.", "info");
        }
      }

      var scanDelays: Record<string, number> = {
        aggressive: 3000,
        standard: 10000,
        safe: 30000,
      };
      var settings2 = await storage.getMarketSettings();
      var delay = scanDelays[settings2?.scanFrequency || "standard"] || 10000;
      var jitter = randomBetween(0, Math.floor(delay * 0.3));

      this.marketTimer = setTimeout(() => this.marketScanLoop(), delay + jitter);
    } catch (err: any) {
      await this.addLog(`Błąd pętli skanowania: ${err.message}`, "error");
      this.marketWindowOpen = false;
      this.marketTimer = setTimeout(() => this.marketScanLoop(), 15000);
    }
  }

  private async switchToCityKeepWindow(gameId: number) {
    var page = this.core.page;
    if (!page) return;

    var currentTownId = await page.evaluate(function() {
      try { return (window as any).Game?.townId || (window as any).ITowns?.getCurrentTown()?.id; } catch(e) { return 0; }
    });

    if (currentTownId === gameId) {
      await this.addLog(`Już jestem w mieście ${gameId} — nie przełączam.`, "info");
      return;
    }

    await this.addLog(`Przełączam miasto ${currentTownId} → ${gameId} (bez zamykania okna)...`, "info");

    var switched = await page.evaluate(function(townId) {
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

    await this.addLog(`Przełączanie: metoda="${switched.method}", sukces=${switched.ok}`, "info");

    if (switched?.needsSelect) {
      await humanDelay(800, 1200);
      var selectedFromList = await page.evaluate(function(townId) {
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
      await this.addLog(`Wybór z listy miast: ${selectedFromList?.ok ? 'OK' : 'NIE ZNALEZIONO'}`, "info");
    }

    await humanDelay(2000, 3500);

    var newTownId = await page.evaluate(function() {
      try { return (window as any).Game?.townId || 0; } catch(e) { return 0; }
    });

    if (newTownId !== gameId) {
      await this.addLog(`Fallback: tworzę link z town_id=${gameId}...`, "warning");
      this.marketWindowOpen = false;
      await page.evaluate(function(townId) {
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

      var fallbackTownId = await page.evaluate(function() {
        try { return (window as any).Game?.townId || 0; } catch(e) { return 0; }
      });

      if (fallbackTownId !== gameId) {
        await this.addLog(`Ostateczny fallback: przeładowanie strony z town_id=${gameId}`, "warning");
        var currentUrl = await page.url();
        var baseUrl = currentUrl.split('?')[0].split('#')[0];
        await page.goto(baseUrl + '?town_id=' + gameId, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForFunction(
          function() { return typeof ITowns !== "undefined" && Object.keys(ITowns.getTowns()).length > 0; },
          { timeout: 30000 }
        );
        await humanDelay(2000, 3000);
      }
    }

    var finalTownId = await page.evaluate(function() {
      try { return (window as any).Game?.townId || (window as any).ITowns?.getCurrentTown()?.id; } catch(e) { return 0; }
    });
    await this.addLog(`Po przełączeniu: miasto=${finalTownId} ${finalTownId === gameId ? 'OK' : 'BŁĄD (oczekiwano ' + gameId + ')'}`, finalTownId === gameId ? "info" : "error");
  }

  private async trySellingInCurrentCity(city: any, settings: any, maxPerTransaction: number): Promise<any> {
    var page = this.core.page;
    if (!page) return { sold: false, reason: "Brak strony" };
    if (!this.marketRunning) return { sold: false, reason: "MarketBot zatrzymany." };

    await page.waitForSelector(
      '.spinner_horizontal[data-type="wood"]',
      { timeout: 8000 }
    ).catch(function() { return null; });

    var exchangeData = await page.evaluate(function() {
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
      return { sold: false, reason: 'Nie odczytano danych giełdy: ' + (exchangeData.error || 'brak spinnerów') };
    }

    var resInfo = exchangeData.resources.map(function(r: any) { return r.name + ': ' + r.current + '/' + r.max + ' (wolne=' + r.free + ')'; }).join(', ');
    await this.addLog(`${city.name}: Giełda — ${resInfo}`, "info");

    var availableWood = Math.max(0, (city.wood || 0) - (settings.minWood || 5000));
    var availableStone = Math.max(0, (city.stone || 0) - (settings.minStone || 5000));
    var availableSilver = Math.max(0, (city.silver || 0) - (settings.minSilver || 5000));

    var candidates = [
      { type: 'wood', dataType: 'wood', name: 'Drewno', available: availableWood, exchangeFree: 0 },
      { type: 'stone', dataType: 'stone', name: 'Kamień', available: availableStone, exchangeFree: 0 },
      { type: 'silver', dataType: 'iron', name: 'Srebro', available: availableSilver, exchangeFree: 0 },
    ];

    for (var i = 0; i < candidates.length; i++) {
      var exRes = exchangeData.resources.find(function(r: any) { return r.type === candidates[i].dataType; });
      if (exRes) candidates[i].exchangeFree = exRes.free;
    }

    var bestCandidate: any = null;
    var bestClicks = 0;

    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].available < 500 || candidates[j].exchangeFree < 500) continue;
      var clicks = Math.min(Math.floor(candidates[j].available / 500), Math.floor(candidates[j].exchangeFree / 500));
      if (clicks > bestClicks) {
        bestClicks = clicks;
        bestCandidate = candidates[j];
      }
    }

    if (!bestCandidate || bestClicks <= 0) {
      var reason = candidates.map(function(c: any) { return c.name + ': dostępne=' + c.available + ', wolne_na_giełdzie=' + c.exchangeFree; }).join('; ');
      return { sold: false, reason: 'Nie ma co sprzedawać — ' + reason };
    }

    var totalToSell = bestClicks * 500;
    await this.addLog(`${city.name}: Sprzedaję ${bestCandidate.name} — ${totalToSell} (wolne na giełdzie=${bestCandidate.exchangeFree})...`, "info");

    if (!this.marketRunning) return { sold: false, reason: "MarketBot zatrzymany." };

    var clickDataType = bestCandidate.dataType;

    await this.addLog(`${city.name}: Wpisuję ${totalToSell} w pole ${bestCandidate.name}...`, "info");

    var inputSelector = '.gp_tab_page.active[data-type="sell"] .spinner_horizontal[data-type="' + clickDataType + '"] input';

    await page.waitForSelector(inputSelector, { visible: true });

    await page.click(inputSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');

    await page.type(inputSelector, totalToSell.toString(), {
  delay: randomBetween(100, 200)
});

    await page.keyboard.press('Tab');

    await humanDelay(1800, 3400);


    await page.waitForFunction(function() {
      var btn = document.querySelector('.gp_tab_page.active .button_new.btn_find_rates');
      if (!btn) return false;
      return !btn.classList.contains('disabled');
    }, { timeout: 15000 });

    await this.addLog(`${city.name}: Klikam "Znajdź najlepsze kursy wymiany"...`, "info");

await page.hover('.gp_tab_page.active .button_new.btn_find_rates');
await humanDelay(200, 600);

await page.click('.gp_tab_page.active .button_new.btn_find_rates');

    await new Promise(function(r) { setTimeout(r, 1500); });

    await page.waitForFunction(function() {
      var btn = document.querySelector('.btn_confirm');
      if (!btn) return false;

      var isDisabled =
        btn.classList.contains('disabled') ||
        btn.getAttribute('data-disabled') === 'true' ||
        btn.getAttribute('disabled') !== null;

      var style = window.getComputedStyle(btn);
      var blocked = style.pointerEvents === 'none' || style.opacity === '0.5';

      return !isDisabled && !blocked;
    }, { timeout: 15000 });

    await humanDelay(800, 1200);

    if (!this.marketRunning) return { sold: false, reason: "MarketBot zatrzymany." };

    await this.addLog(`${city.name}: Klikam "Potwierdź zamówienie"...`, "info");

    var beforeFree = await page.evaluate(function(dt) {
      var spinner = document.querySelector('.spinner_horizontal[data-type="' + dt + '"]');
      if (!spinner) return null;

      var container = spinner.parentElement;
      while (container) {
        var curEl = container.querySelector('.current');
        var maxEl = container.querySelector('.max');
        if (curEl && maxEl) {
          var current = parseInt((curEl.textContent || '0').replace(/[\s.,]/g, ''));
          var max = parseInt((maxEl.textContent || '0').replace(/[\s.,]/g, ''));
          return max - current;
        }
        container = container.parentElement;
      }
      return null;
    }, clickDataType);

    if (beforeFree === null) {
      return { sold: false, reason: "Nie udało się odczytać stanu giełdy przed sprzedażą." };
    }

    await page.evaluate(function() {
      var btn = document.querySelector('.btn_confirm') as HTMLElement;
      if (btn) btn.click();
    });

    await page.waitForFunction(function(dt: string, before: number) {
      var spinner = document.querySelector('.spinner_horizontal[data-type="' + dt + '"]');
      if (!spinner) return false;

      var container = spinner.parentElement;
      while (container) {
        var curEl = container.querySelector('.current');
        var maxEl = container.querySelector('.max');
        if (curEl && maxEl) {
          var current = parseInt((curEl.textContent || '0').replace(/[\s.,]/g, ''));
          var max = parseInt((maxEl.textContent || '0').replace(/[\s.,]/g, ''));
          var free = max - current;
          return free !== before;
        }
        container = container.parentElement;
      }

      return false;
    }, { timeout: 15000 }, clickDataType, beforeFree);

    var afterData = await page.evaluate(function(dt) {
      var spinner = document.querySelector('.spinner_horizontal[data-type="' + dt + '"]');
      if (!spinner) return null;

      var container = spinner.parentElement;
      while (container) {
        var curEl = container.querySelector('.current');
        var maxEl = container.querySelector('.max');
        if (curEl && maxEl) {
          var current = parseInt((curEl.textContent || '0').replace(/[\s.,]/g, ''));
          var max = parseInt((maxEl.textContent || '0').replace(/[\s.,]/g, ''));
          return { current: current, max: max, free: max - current };
        }
        container = container.parentElement;
      }
      return null;
    }, clickDataType);

    if (!afterData || afterData.free === beforeFree) {
      return { sold: false, reason: "Backend nie zmienił stanu giełdy — sprzedaż nie przeszła." };
    }

    await humanDelay(1500, 2500);

    await this.addLog(`${city.name}: Sprzedano ${bestCandidate.name}: ${totalToSell}!`, "success");

    return {
      sold: true,
      woodSold: bestCandidate.type === 'wood' ? totalToSell : 0,
      stoneSold: bestCandidate.type === 'stone' ? totalToSell : 0,
      silverSold: bestCandidate.type === 'silver' ? totalToSell : 0,
    };
  }

  private async closePopup() {
    try {
      await this.core.page?.evaluate(function() {
        var closeBtns = document.querySelectorAll('.btn_wnd.close');
        for (var i = 0; i < closeBtns.length; i++) {
          try { (closeBtns[i] as HTMLElement).click(); } catch(e) {}
        }
        var uiClose = document.querySelector(".ui-dialog-titlebar-close");
        if (uiClose) (uiClose as any).click();
      });
    } catch(e) {}
    this.marketWindowOpen = false;
  }
}