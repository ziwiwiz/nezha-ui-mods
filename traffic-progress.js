(() => {
  'use strict';

  const VERSION = 'v20260803';
  const INSTANCE_KEY = '__nezhaTrafficProgress';

  // Avoid duplicate timers/observers when the script is injected more than once.
  const previous = window[INSTANCE_KEY];
  if (previous?.version === VERSION) return;
  if (typeof previous?.destroy === 'function') previous.destroy();

  const DEFAULT_CONFIG = {
    showTrafficStats: true,
    insertAfter: true,
    interval: 60000,
    toggleInterval: 5000,
    duration: 500,
    apiUrl: '/api/v1/service',
    enableLog: false
  };

  const TARGET_SELECTOR = 'section.server-card-list, section.server-inline-list';
  const CARD_TITLE_SELECTOR = 'section.grid.items-center.gap-2';
  const INJECTED_CLASS = 'new-inserted-element';
  const STYLE_ID = 'nezha-traffic-progress-style';

  let config = readConfig();
  let destroyed = false;
  let currentSection = null;
  let sectionDetector = null;
  let childObserver = null;
  let trafficTimer = null;
  let toggleTimer = null;
  let updateTimer = null;
  let detectorFrame = null;
  let updateRunning = false;
  let updateRequested = false;
  let toggleIndex = 0;

  // One bounded entry per currently rendered server.
  const entries = new Map();

  let trafficCache = null;
  let inFlightRequest = null;

  function readConfig() {
    return Object.assign({}, DEFAULT_CONFIG, window.TrafficScriptConfig || {});
  }

  function log(...args) {
    if (config.enableLog) console.log(`[TrafficScript ${VERSION}]`, ...args);
  }

  function injectCustomCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.mt-4.w-full.mx-auto > div { display: none; }';
    document.head.appendChild(style);
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return { value: '0', unit: 'B' };
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let size = Number(bytes) || 0;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return {
      value: size.toFixed(unitIndex === 0 ? 0 : 2),
      unit: units[unitIndex]
    };
  }

  function calculatePercentage(used, total) {
    let normalizedUsed = Number(used);
    let normalizedTotal = Number(total);
    if (normalizedUsed > 1e15 || normalizedTotal > 1e15) {
      normalizedUsed /= 1e10;
      normalizedTotal /= 1e10;
    }
    return normalizedTotal === 0
      ? '0.00'
      : ((normalizedUsed / normalizedTotal) * 100).toFixed(2);
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  }

  function getHslGradientColor(percentage) {
    const p = Math.min(Math.max(Number(percentage), 0), 100);
    const lerp = (start, end, value) => start + (end - start) * value;
    let h;
    let s;
    let l;

    if (p <= 35) {
      const t = p / 35;
      h = lerp(142, 32, t);
      s = lerp(69, 85, t);
      l = lerp(45, 55, t);
    } else if (p <= 85) {
      const t = (p - 35) / 50;
      h = lerp(32, 0, t);
      s = lerp(85, 75, t);
      l = lerp(55, 50, t);
    } else {
      const t = (p - 85) / 15;
      h = 0;
      s = 75;
      l = lerp(50, 45, t);
    }

    return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
  }

  function setTextIfChanged(parent, selector, nextValue) {
    const element = parent.querySelector(selector);
    if (element && element.textContent !== nextValue) element.textContent = nextValue;
  }

  function setStyleIfChanged(element, property, nextValue) {
    if (element && element.style[property] !== nextValue) {
      element.style[property] = nextValue;
    }
  }

  function clearEntry(entry, removeElement = false) {
    if (entry.fadeTimer) clearTimeout(entry.fadeTimer);
    entry.fadeTimer = null;
    if (removeElement && entry.el?.isConnected) entry.el.remove();
  }

  function pruneEntries(activeIds = null) {
    for (const [id, entry] of entries) {
      if (!entry.el?.isConnected || (activeIds && !activeIds.has(id))) {
        clearEntry(entry, false);
        entries.delete(id);
      }
    }
  }

  function buildServerElementMap() {
    const map = new Map();
    document.querySelectorAll(CARD_TITLE_SELECTOR).forEach((section) => {
      const name = section.querySelector('p')?.textContent?.trim();
      if (name && !map.has(name)) map.set(name, section);
    });
    return map;
  }

  function normalizeTrafficData(trafficData) {
    const servers = new Map();
    for (const cycleId in trafficData) {
      const cycle = trafficData[cycleId];
      if (!cycle?.server_name || !cycle?.transfer) continue;
      for (const serverId in cycle.server_name) {
        const name = cycle.server_name[serverId];
        const transfer = cycle.transfer[serverId];
        const nextUpdate = cycle.next_update?.[serverId];
        if (!name || transfer === undefined || !cycle.max || !cycle.from || !cycle.to) continue;
        servers.set(name, {
          id: String(serverId),
          transfer,
          max: cycle.max,
          from: cycle.from,
          to: cycle.to,
          nextUpdate
        });
      }
    }
    return servers;
  }

  function createMarkup(data) {
    return `
      <div class="flex items-center justify-between">
        <div class="flex items-baseline gap-1">
          <span class="text-[10px] font-medium text-neutral-800 dark:text-neutral-200 used-traffic">${data.used.value}</span>
          <span class="text-[10px] font-medium text-neutral-800 dark:text-neutral-200 used-unit">${data.used.unit}</span>
          <span class="text-[10px] text-neutral-500 dark:text-neutral-400">/ </span>
          <span class="text-[10px] text-neutral-500 dark:text-neutral-400 total-traffic">${data.total.value}</span>
          <span class="text-[10px] text-neutral-500 dark:text-neutral-400 total-unit">${data.total.unit}</span>
        </div>
        <div class="text-[10px] font-medium text-neutral-600 dark:text-neutral-300 time-info" style="opacity:1; transition: opacity 0.3s;">
          ${data.contents[0]}
        </div>
      </div>
      <div class="relative h-1.5">
        <div class="absolute inset-0 bg-neutral-100 dark:bg-neutral-800 rounded-full"></div>
        <div class="absolute inset-0 bg-emerald-500 rounded-full transition-all duration-300 progress-bar" style="width:${data.percentage}%; max-width:100%; background-color:${data.color};"></div>
      </div>`;
  }

  function findExistingElement(container, id) {
    return Array.from(container.querySelectorAll(`.${INJECTED_CLASS}`))
      .find((element) => element.dataset.trafficServerId === id) || null;
  }

  function updateEntry(entry, data) {
    const element = entry.el;
    setTextIfChanged(element, '.used-traffic', data.used.value);
    setTextIfChanged(element, '.used-unit', data.used.unit);
    setTextIfChanged(element, '.total-traffic', data.total.value);
    setTextIfChanged(element, '.total-unit', data.total.unit);
    setTextIfChanged(element, '.from-date', data.from);
    setTextIfChanged(element, '.to-date', data.to);
    setTextIfChanged(element, '.percentage-value', `${data.percentage}%`);
    setTextIfChanged(element, '.next-update', data.nextUpdate);

    const progressBar = element.querySelector('.progress-bar');
    setStyleIfChanged(progressBar, 'width', `${data.percentage}%`);
    setStyleIfChanged(progressBar, 'backgroundColor', data.color);

    // Keep rotating content current without creating another array entry.
    entry.contents = data.contents;
  }

  function renderTrafficStats(trafficData) {
    if (destroyed) return;

    const serverElements = buildServerElementMap();
    const servers = normalizeTrafficData(trafficData);
    const activeIds = new Set();

    for (const [serverName, serverData] of servers) {
      const targetElement = serverElements.get(serverName.trim());
      if (!targetElement) continue;

      const container = targetElement.closest('div');
      if (!container) continue;

      const id = serverData.id;
      activeIds.add(id);

      let entry = entries.get(id);
      if (entry && (!entry.el.isConnected || !container.contains(entry.el))) {
        clearEntry(entry, false);
        entries.delete(id);
        entry = null;
      }

      const used = formatFileSize(serverData.transfer);
      const total = formatFileSize(serverData.max);
      const percentage = calculatePercentage(serverData.transfer, serverData.max);
      const from = formatDate(serverData.from);
      const to = formatDate(serverData.to);
      const nextUpdate = serverData.nextUpdate
        ? new Date(serverData.nextUpdate).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : '';
      const color = getHslGradientColor(percentage);
      const contents = [
        `<span class="from-date">${from}</span>
                <span class="text-neutral-500 dark:text-neutral-400">-</span>
                <span class="to-date">${to}</span>`,
        `<span class="text-[10px] font-medium text-neutral-800 dark:text-neutral-200 percentage-value">${percentage}%</span>`,
        `<span class="text-[10px] font-medium text-neutral-600 dark:text-neutral-300 next-update">${nextUpdate}</span>`
      ];
      const viewData = { used, total, percentage, from, to, nextUpdate, color, contents };

      let element = entry?.el || findExistingElement(container, id);

      if (!config.showTrafficStats) {
        if (element) element.remove();
        if (entry) clearEntry(entry, false);
        entries.delete(id);
        continue;
      }

      if (!element) {
        const anchor = config.insertAfter
          ? container.querySelector('section.flex.items-center.w-full.justify-between.gap-1')
            || container.querySelector('section.grid.items-center.gap-3')
          : container.querySelector('section.grid.items-center.gap-3');
        if (!anchor) continue;

        element = document.createElement('div');
        element.className = `space-y-1.5 ${INJECTED_CLASS} traffic-stats-for-server-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        element.dataset.trafficServerId = id;
        element.style.width = '100%';
        element.innerHTML = createMarkup(viewData);
        anchor.after(element);
        entry = { el: element, contents, fadeTimer: null };
        entries.set(id, entry);
      } else {
        if (!entry) {
          entry = { el: element, contents, fadeTimer: null };
          entries.set(id, entry);
        }
        updateEntry(entry, viewData);
      }
    }

    pruneEntries(activeIds);
    log(`rendered ${entries.size} traffic entries`);
  }

  async function getTrafficData() {
    const now = Date.now();
    if (trafficCache && now - trafficCache.timestamp < config.interval) {
      return trafficCache.data;
    }
    if (inFlightRequest) return inFlightRequest;

    inFlightRequest = fetch(config.apiUrl, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (!payload?.success) throw new Error('Unexpected traffic API response');
        const data = payload.data?.cycle_transfer_stats || {};
        trafficCache = { timestamp: Date.now(), data };
        return data;
      })
      .catch((error) => {
        if (config.enableLog) console.error('[TrafficScript] request failed:', error);
        return trafficCache?.data || null;
      })
      .finally(() => {
        inFlightRequest = null;
      });

    return inFlightRequest;
  }

  async function updateTrafficStats() {
    if (destroyed || document.hidden) return;
    if (updateRunning) {
      updateRequested = true;
      return;
    }

    updateRunning = true;
    try {
      const trafficData = await getTrafficData();
      if (trafficData && !destroyed && !document.hidden) renderTrafficStats(trafficData);
    } finally {
      updateRunning = false;
      if (updateRequested) {
        updateRequested = false;
        scheduleUpdate(50);
      }
    }
  }

  function scheduleUpdate(delay = 80) {
    if (destroyed || document.hidden) return;
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      updateTrafficStats();
    }, delay);
  }

  function rotateEntries() {
    if (destroyed || document.hidden || entries.size === 0) return;
    toggleIndex += 1;
    const index = toggleIndex % 3;

    pruneEntries();
    for (const entry of entries.values()) {
      const element = entry.el.querySelector('.time-info');
      const content = entry.contents[index];
      if (!element || !content) continue;

      if (entry.fadeTimer) clearTimeout(entry.fadeTimer);
      const halfDuration = Math.max(0, config.duration / 2);
      setStyleIfChanged(element, 'transition', `opacity ${halfDuration}ms`);
      setStyleIfChanged(element, 'opacity', '0');
      entry.fadeTimer = setTimeout(() => {
        entry.fadeTimer = null;
        if (!element.isConnected || destroyed) return;
        if (element.innerHTML !== content) element.innerHTML = content;
        setStyleIfChanged(element, 'opacity', '1');
      }, halfDuration);
    }
  }

  function stopTimers() {
    if (trafficTimer) clearInterval(trafficTimer);
    if (toggleTimer) clearInterval(toggleTimer);
    trafficTimer = null;
    toggleTimer = null;
  }

  function startTimers() {
    stopTimers();
    if (destroyed || document.hidden) return;
    if (config.interval > 0) {
      trafficTimer = setInterval(updateTrafficStats, config.interval);
    }
    if (config.toggleInterval > 0) {
      toggleTimer = setInterval(rotateEntries, config.toggleInterval);
    }
  }

  function observeSection(section) {
    if (section === currentSection && childObserver) return;
    if (childObserver) childObserver.disconnect();
    currentSection = section;
    childObserver = new MutationObserver(() => scheduleUpdate());
    childObserver.observe(section, { childList: true, subtree: false });
    scheduleUpdate(0);
  }

  function detectSection() {
    detectorFrame = null;
    if (destroyed) return;
    const section = document.querySelector(TARGET_SELECTOR);
    if (section && section !== currentSection) observeSection(section);
  }

  function scheduleSectionDetection() {
    if (detectorFrame !== null || destroyed) return;
    detectorFrame = requestAnimationFrame(detectSection);
  }

  function mutationMayAffectSection(mutations) {
    if (!currentSection?.isConnected) return true;
    for (const mutation of mutations) {
      // The child observer owns changes inside the active list.
      if (currentSection.contains(mutation.target)) continue;
      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.(TARGET_SELECTOR) || node.querySelector?.(TARGET_SELECTOR)) return true;
      }
    }
    return false;
  }

  function startObservers() {
    const root = document.querySelector('main') || document.body;
    sectionDetector = new MutationObserver((mutations) => {
      if (mutationMayAffectSection(mutations)) scheduleSectionDetection();
    });
    sectionDetector.observe(root, { childList: true, subtree: true });
    detectSection();
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopTimers();
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = null;
      for (const entry of entries.values()) {
        if (entry.fadeTimer) clearTimeout(entry.fadeTimer);
        entry.fadeTimer = null;
      }
      return;
    }

    startTimers();
    scheduleSectionDetection();
    scheduleUpdate(0);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopTimers();
    if (updateTimer) clearTimeout(updateTimer);
    if (detectorFrame !== null) cancelAnimationFrame(detectorFrame);
    if (sectionDetector) sectionDetector.disconnect();
    if (childObserver) childObserver.disconnect();
    for (const entry of entries.values()) clearEntry(entry, false);
    entries.clear();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('beforeunload', destroy);
  }

  injectCustomCSS();
  startObservers();
  startTimers();
  scheduleUpdate(0);

  document.addEventListener('visibilitychange', handleVisibilityChange, { passive: true });
  window.addEventListener('beforeunload', destroy, { once: true });

  // Preserve support for configuration assigned shortly after script parsing.
  setTimeout(() => {
    if (destroyed) return;
    const nextConfig = readConfig();
    if (JSON.stringify(nextConfig) === JSON.stringify(config)) return;
    config = nextConfig;
    startTimers();
    scheduleUpdate(0);
  }, 100);

  window[INSTANCE_KEY] = {
    version: VERSION,
    destroy,
    refresh() {
      trafficCache = null;
      scheduleUpdate(0);
    },
    getEntryCount() {
      pruneEntries();
      return entries.size;
    }
  };
})();
