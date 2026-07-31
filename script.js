document.addEventListener("DOMContentLoaded", () => {
  const DEFAULT_WATCHLIST = ["bitcoin", "ethereum", "solana", "binancecoin"];
  
  let watchlist = JSON.parse(localStorage.getItem("pulsevault-watchlist")) || DEFAULT_WATCHLIST;
  let holdings = JSON.parse(localStorage.getItem("pulsevault-holdings")) || {};
  let marketData = [];
  let currentSort = localStorage.getItem("pulsevault-sort") || "market_cap_desc";
  let needsFullRender = true;
  
  const charts = {};
  let portfolioChartInstance = null; 
  
  // Modal & WebSocket State
  let modalChartInstance = null;
  let currentModalCoin = null;
  let priceWebSocket = null; // NEW: WebSocket instance

  // DOM Elements
  const themeSwitch = document.getElementById("themeSwitch");
  const statusPanel = document.getElementById("statusPanel");
  const statusMessage = document.getElementById("statusMessage");
  const dashboardGrid = document.getElementById("dashboardGrid");
  const watchlistCount = document.getElementById("watchlistCount");
  const searchInput = document.getElementById("searchInput");
  const searchDropdown = document.getElementById("searchDropdown");
  const sortSelect = document.getElementById("sortSelect");
  const globalMarquee = document.getElementById("globalMarquee");
  const totalBalanceEl = document.getElementById("totalBalance");

  // Modal DOM
  const modalBackdrop = document.getElementById("modalBackdrop");
  const modalCloseBtn = document.getElementById("modalCloseBtn");
  const modalCoinLogo = document.getElementById("modalCoinLogo");
  const modalCoinName = document.getElementById("modalCoinName");
  const modalCoinSymbol = document.getElementById("modalCoinSymbol");
  const modalCoinRank = document.getElementById("modalCoinRank");
  const modalCoinPrice = document.getElementById("modalCoinPrice");
  const modalCoinChange = document.getElementById("modalCoinChange");
  const modalLow24h = document.getElementById("modalLow24h");
  const modalHigh24h = document.getElementById("modalHigh24h");
  const modalRangeFill = document.getElementById("modalRangeFill");
  const modalAth = document.getElementById("modalAth");
  const modalAthChange = document.getElementById("modalAthChange");
  const modalSupply = document.getElementById("modalSupply");
  const modalMcap = document.getElementById("modalMcap");
  const modalVol = document.getElementById("modalVol");
  const timeframeSelector = document.getElementById("timeframeSelector");

  sortSelect.value = currentSort;

  function formatPrice(val) {
    if (typeof val !== "number") return "$--";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: val < 1 ? 6 : 2 }).format(val);
  }

  function formatCompact(val) {
    if (typeof val !== "number") return "$--";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(val);
  }

  function formatChange(val) {
    if (typeof val !== "number") return "--";
    return `${val > 0 ? "+" : ""}${val.toFixed(2)}%`;
  }

  function saveWatchlist() {
    localStorage.setItem("pulsevault-watchlist", JSON.stringify(watchlist));
    if (watchlistCount) watchlistCount.textContent = `${watchlist.length} Asset${watchlist.length === 1 ? "" : "s"}`;
  }

  function saveHoldings() {
    localStorage.setItem("pulsevault-holdings", JSON.stringify(holdings));
  }

  function setStatus(msg, isError = false) {
    statusMessage.textContent = msg;
    statusPanel.classList.toggle("error", isError);
  }

  function setLoading(isLoading) {
    statusPanel.classList.toggle("loading", isLoading);
  }

  function sortData(data, sortKey) {
    return [...data].sort((a, b) => {
      switch (sortKey) {
        case "price_desc": return b.current_price - a.current_price;
        case "price_asc": return a.current_price - b.current_price;
        case "change_desc": return (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0);
        case "change_asc": return (a.price_change_percentage_24h || 0) - (b.price_change_percentage_24h || 0);
        case "volume_desc": return b.total_volume - a.total_volume;
        case "market_cap_desc":
        default: return b.market_cap - a.market_cap;
      }
    });
  }

  // --- NEW: Unlimited Live WebSockets Engine ---
  function connectWebSocket() {
    if (priceWebSocket) {
      priceWebSocket.close();
    }
    if (watchlist.length === 0) return;

    // CoinCap uses 'binance-coin' instead of CoinGecko's 'binancecoin'
    const wsList = watchlist.map(id => id === "binancecoin" ? "binance-coin" : id);
    
    priceWebSocket = new WebSocket(`wss://ws.coincap.io/prices?assets=${wsList.join(",")}`);

    priceWebSocket.onmessage = (event) => {
      const livePrices = JSON.parse(event.data);
      let needsPortfolioUpdate = false;

      for (const [ccId, newPriceStr] of Object.entries(livePrices)) {
        const coinId = ccId === "binance-coin" ? "binancecoin" : ccId;
        const newPrice = parseFloat(newPriceStr);

        const coinIndex = marketData.findIndex(c => c.id === coinId);
        if (coinIndex === -1) continue;

        const oldPrice = marketData[coinIndex].current_price;
        if (oldPrice === newPrice) continue; 

        // Update state
        marketData[coinIndex].current_price = newPrice;
        needsPortfolioUpdate = true;

        // Flash Card DOM
        const card = document.querySelector(`article[data-coin="${coinId}"]`);
        if (card) {
          const priceEl = card.querySelector(".price");
          priceEl.textContent = formatPrice(newPrice);
          
          priceEl.classList.add(newPrice > oldPrice ? "flash-up" : "flash-down");
          setTimeout(() => priceEl.classList.remove("flash-up", "flash-down"), 600);

          const valEl = document.getElementById(`val-${coinId}`);
          if (valEl && holdings[coinId]) {
            valEl.textContent = formatPrice(parseFloat(holdings[coinId]) * newPrice);
          }
        }

        // Flash Modal DOM if open
        if (currentModalCoin === coinId && !modalBackdrop.hidden) {
          modalCoinPrice.textContent = formatPrice(newPrice);
          modalCoinPrice.classList.add(newPrice > oldPrice ? "flash-up" : "flash-down");
          setTimeout(() => modalCoinPrice.classList.remove("flash-up", "flash-down"), 600);
        }
      }

      if (needsPortfolioUpdate) {
        updatePortfolio();
      }
    };

    priceWebSocket.onerror = (err) => console.error("WebSocket Error:", err);
  }

  // --- Portfolio Visualizer ---
  function updatePortfolio() {
    if (!totalBalanceEl) return;
    let totalValue = 0;
    const labels = [];
    const dataVals = [];
    const colors = ["#2563eb", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#14b8a6", "#f43f5e"];

    marketData.forEach((coin) => {
      const qty = parseFloat(holdings[coin.id]) || 0;
      if (qty > 0) {
        const value = qty * coin.current_price;
        totalValue += value;
        labels.push(coin.symbol.toUpperCase());
        dataVals.push(value);
      }
    });

    totalBalanceEl.textContent = formatPrice(totalValue);
    const isDark = document.body.classList.contains("dark-mode");
    const gridColor = isDark ? "#0f172a" : "#ffffff";

    if (portfolioChartInstance) {
      if (totalValue === 0) {
        portfolioChartInstance.data.labels = [];
        portfolioChartInstance.data.datasets[0].data = [1];
        portfolioChartInstance.data.datasets[0].backgroundColor = ["rgba(127, 140, 162, 0.2)"];
        portfolioChartInstance.data.datasets[0].borderWidth = 0;
      } else {
        portfolioChartInstance.data.labels = labels;
        portfolioChartInstance.data.datasets[0].data = dataVals;
        portfolioChartInstance.data.datasets[0].backgroundColor = colors.slice(0, dataVals.length);
        portfolioChartInstance.data.datasets[0].borderColor = gridColor;
        portfolioChartInstance.data.datasets[0].borderWidth = 4;
      }
      portfolioChartInstance.update("none");
      return; 
    }

    const ctx = document.getElementById("portfolioChart").getContext("2d");
    if (totalValue === 0) {
      portfolioChartInstance = new Chart(ctx, {
        type: "doughnut",
        data: { datasets: [{ data: [1], backgroundColor: ["rgba(127, 140, 162, 0.2)"], borderWidth: 0 }] },
        options: { cutout: "75%", plugins: { tooltip: { enabled: false } }, responsive: true, maintainAspectRatio: false }
      });
    } else {
      portfolioChartInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
          labels: labels,
          datasets: [{ data: dataVals, backgroundColor: colors.slice(0, dataVals.length), borderWidth: 4, borderColor: gridColor, hoverOffset: 4 }]
        },
        options: {
          cutout: "75%",
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => ` ${context.label}: ${formatPrice(context.raw)}` } } },
          responsive: true, maintainAspectRatio: false, animation: { duration: 0 } 
        }
      });
    }
  }

  // --- HTML Builder ---
  function renderDashboard() {
    Object.keys(charts).forEach((id) => {
      if (charts[id]) charts[id].destroy();
      delete charts[id];
    });
    dashboardGrid.innerHTML = "";

    if (watchlist.length === 0) {
      dashboardGrid.innerHTML = `<div class="empty-state"><h3>Your Watchlist is Empty</h3><p>Use the search bar above to add cryptocurrencies.</p></div>`;
      saveWatchlist(); updatePortfolio(); return;
    }

    const sortedData = sortData(marketData, currentSort);
    sortedData.forEach((coin) => {
      const isPositive = (coin.price_change_percentage_24h || 0) >= 0;
      const userQty = holdings[coin.id] || "";
      const userVal = userQty ? formatPrice(parseFloat(userQty) * coin.current_price) : "$0.00";

      const card = document.createElement("article");
      card.className = "asset-card"; card.setAttribute("data-coin", coin.id);

      card.innerHTML = `
        <div class="asset-top">
          <div class="coin-info" style="cursor: pointer;" data-open-modal="${coin.id}">
            <img class="coin-logo" src="${coin.image}" alt="${coin.name} logo" />
            <div><h3>${coin.name} ↗</h3><p>${coin.symbol}</p></div>
          </div>
          <div class="asset-actions"><button class="remove-btn" title="Remove ${coin.name}" data-id="${coin.id}">×</button></div>
        </div>
        <div class="asset-body">
          <div class="metrics-grid">
            <div class="metric-block"><span class="label">Live Price</span><strong class="price">${formatPrice(coin.current_price)}</strong></div>
            <div class="metric-block"><span class="label">24h Change</span><strong class="change ${isPositive ? "positive" : "negative"}">${formatChange(coin.price_change_percentage_24h)}</strong></div>
            <div class="metric-block"><span class="label">Market Cap</span><strong class="sub-metric">${formatCompact(coin.market_cap)}</strong></div>
            <div class="metric-block"><span class="label">24h Volume</span><strong class="sub-metric">${formatCompact(coin.total_volume)}</strong></div>
          </div>
          <div class="chart-container"><canvas id="chart-${coin.id}"></canvas></div>
          <div class="card-calc-bar">
            <div class="holdings-input-wrapper"><span>Holdings:</span><input type="number" class="holdings-input" data-coin-id="${coin.id}" placeholder="0.00" value="${userQty}" step="any" /></div>
            <span class="holdings-val" id="val-${coin.id}">${userVal}</span>
          </div>
        </div>`;

      dashboardGrid.appendChild(card);
      if (coin.sparkline_in_7d && coin.sparkline_in_7d.price) {
        renderChart(coin.id, document.getElementById(`chart-${coin.id}`).getContext("2d"), coin.sparkline_in_7d.price, isPositive);
      }
    });

    document.querySelectorAll(".remove-btn").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); removeCoin(btn.getAttribute("data-id")); }));
    document.querySelectorAll("[data-open-modal]").forEach((elem) => elem.addEventListener("click", () => openModal(elem.getAttribute("data-open-modal"))));
    document.querySelectorAll(".holdings-input").forEach((input) => {
      input.addEventListener("input", (e) => {
        const id = e.target.getAttribute("data-coin-id");
        holdings[id] = e.target.value; saveHoldings();
        const coin = marketData.find((c) => c.id === id);
        if (coin) { document.getElementById(`val-${id}`).textContent = formatPrice((parseFloat(e.target.value) || 0) * coin.current_price); updatePortfolio(); }
      });
    });

    saveWatchlist(); updatePortfolio();
  }

  function updateDashboard() {
    marketData.forEach((coin) => {
      const card = document.querySelector(`article[data-coin="${coin.id}"]`);
      if (!card) return;
      const isPositive = (coin.price_change_percentage_24h || 0) >= 0;
      
      const changeEl = card.querySelector(".change");
      changeEl.textContent = formatChange(coin.price_change_percentage_24h); changeEl.className = `change ${isPositive ? "positive" : "negative"}`;

      const subMetrics = card.querySelectorAll(".sub-metric");
      if (subMetrics.length >= 2) { subMetrics[0].textContent = formatCompact(coin.market_cap); subMetrics[1].textContent = formatCompact(coin.total_volume); }

      if (charts[coin.id] && coin.sparkline_in_7d && coin.sparkline_in_7d.price) {
        const isDark = document.body.classList.contains("dark-mode");
        charts[coin.id].data.datasets[0].data = coin.sparkline_in_7d.price;
        charts[coin.id].data.datasets[0].borderColor = isPositive ? (isDark ? "#4ade80" : "#00c853") : (isDark ? "#fb7185" : "#ff1744");
        charts[coin.id].update("none");
      }
    });
  }

  function renderChart(coinId, ctx, prices, isPositive) {
    const isDark = document.body.classList.contains("dark-mode");
    charts[coinId] = new Chart(ctx, {
      type: "line",
      data: { labels: prices.map((_, i) => i), datasets: [{ data: prices, borderColor: isPositive ? (isDark ? "#4ade80" : "#00c853") : (isDark ? "#fb7185" : "#ff1744"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.35 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, interaction: { intersect: false, mode: "index" } }
    });
  }

  // --- Modal Deep Chart Engine ---
  async function fetchModalChart(coinId, days) {
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`);
      if (!res.ok) return;
      const data = await res.json();
      
      const prices = data.prices;
      const labels = prices.map(p => {
        const d = new Date(p[0]);
        if (days === "1") return d.toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      });
      const dataPoints = prices.map(p => p[1]);
      
      const isPositive = dataPoints[dataPoints.length - 1] >= dataPoints[0];
      const isDark = document.body.classList.contains("dark-mode");
      const lineColor = isPositive ? (isDark ? "#4ade80" : "#00c853") : (isDark ? "#fb7185" : "#ff1744");
      const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
      const textColor = isDark ? "#94a3b8" : "#64748b";
      
      const ctx = document.getElementById("modalDeepChart").getContext("2d");

      if (modalChartInstance) {
        modalChartInstance.data.labels = labels;
        modalChartInstance.data.datasets[0].data = dataPoints;
        modalChartInstance.data.datasets[0].borderColor = lineColor;
        modalChartInstance.data.datasets[0].pointBackgroundColor = lineColor;
        
        modalChartInstance.options.scales.x.ticks.color = textColor;
        modalChartInstance.options.scales.y.ticks.color = textColor;
        modalChartInstance.options.scales.y.grid.color = gridColor;
        modalChartInstance.update();
      } else {
        modalChartInstance = new Chart(ctx, {
          type: "line",
          data: {
            labels: labels,
            datasets: [{
              data: dataPoints,
              borderColor: lineColor,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 6,
              pointBackgroundColor: lineColor,
              tension: 0.1,
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { 
              legend: { display: false },
              tooltip: { intersect: false, mode: 'index', callbacks: { label: (context) => ` Price: ${formatPrice(context.raw)}` } }
            },
            scales: { 
              x: { display: true, grid: { display: false }, ticks: { color: textColor, maxTicksLimit: 6, maxRotation: 0 } }, 
              y: { display: true, position: 'right', grid: { color: gridColor }, ticks: { color: textColor, callback: (val) => formatPrice(val) } } 
            },
            interaction: { mode: "index", intersect: false }
          }
        });
      }
    } catch (err) { console.error("Deep Chart Fetch Error:", err); }
  }

  if (timeframeSelector) {
    timeframeSelector.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON") {
        document.querySelectorAll(".tf-btn").forEach(btn => btn.classList.remove("active"));
        e.target.classList.add("active");
        const days = e.target.getAttribute("data-days");
        if (currentModalCoin) fetchModalChart(currentModalCoin, days);
      }
    });
  }

  function openModal(coinId) {
    const coin = marketData.find((c) => c.id === coinId);
    if (!coin) return;

    currentModalCoin = coinId;
    modalCoinLogo.src = coin.image;
    modalCoinName.textContent = coin.name;
    modalCoinSymbol.textContent = coin.symbol.toUpperCase();
    modalCoinRank.textContent = `Rank #${coin.market_cap_rank || "--"}`;
    modalCoinPrice.textContent = formatPrice(coin.current_price);
    
    const isPositive = (coin.price_change_percentage_24h || 0) >= 0;
    modalCoinChange.textContent = formatChange(coin.price_change_percentage_24h);
    modalCoinChange.className = `change ${isPositive ? "positive" : "negative"}`;
    modalLow24h.textContent = formatPrice(coin.low_24h);
    modalHigh24h.textContent = formatPrice(coin.high_24h);

    if (coin.high_24h && coin.low_24h && coin.high_24h > coin.low_24h) {
      const percentage = ((coin.current_price - coin.low_24h) / (coin.high_24h - coin.low_24h)) * 100;
      modalRangeFill.style.width = `${Math.min(Math.max(percentage, 0), 100)}%`;
    } else {
      modalRangeFill.style.width = "50%";
    }

    modalAth.textContent = formatPrice(coin.ath);
    modalAthChange.textContent = `${coin.ath_change_percentage?.toFixed(1) || "--"}% from ATH`;
    modalSupply.textContent = coin.circulating_supply ? coin.circulating_supply.toLocaleString() : "--";
    modalMcap.textContent = formatCompact(coin.market_cap);
    modalVol.textContent = formatCompact(coin.total_volume);

    document.querySelectorAll(".tf-btn").forEach(btn => btn.classList.remove("active"));
    document.querySelector(".tf-btn[data-days='7']").classList.add("active");
    
    modalBackdrop.hidden = false;
    fetchModalChart(coinId, "7");
  }

  if (modalCloseBtn) modalCloseBtn.addEventListener("click", () => { modalBackdrop.hidden = true; });
  if (modalBackdrop) modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) modalBackdrop.hidden = true;
  });

  // --- API Fetching ---
  async function fetchGlobalData() {
    try {
      const response = await fetch("https://api.coingecko.com/api/v3/global");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()).data;
      if (globalMarquee) {
        globalMarquee.innerHTML = `<span class="marquee-item">Active Assets: <span class="value">${data.active_cryptocurrencies.toLocaleString()}</span></span><span class="marquee-item">Global Market Cap: <span class="value highlight">${formatCompact(data.total_market_cap.usd)}</span></span><span class="marquee-item">24h Volume: <span class="value">${formatCompact(data.total_volume.usd)}</span></span><span class="marquee-item">BTC Dominance: <span class="value highlight">${data.market_cap_percentage.btc.toFixed(1)}%</span></span><span class="marquee-item">DeFi Market Cap: <span class="value">${formatCompact(data.defi_market_cap || 0)}</span></span>`;
        globalMarquee.innerHTML += globalMarquee.innerHTML;
      }
    } catch (err) { console.error("Global Fetch Error:", err); }
  }

  async function fetchMarketData() {
    if (watchlist.length === 0) { marketData = []; renderDashboard(); setStatus("Watchlist empty."); return; }
    try {
      setLoading(true);
      setStatus("Establishing live connection...");
      
      const response = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${watchlist.join(",")}&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=24h`);
      if (!response.ok) throw new Error(response.status === 429 ? "429 Rate Limit" : `HTTP Error ${response.status}`);
      
      marketData = await response.json();
      
      if (needsFullRender) {
        renderDashboard();
        needsFullRender = false;
        connectWebSocket(); // Open WSS connection ONLY after cards are rendered
      } else {
        updateDashboard();
      }
      
      setStatus("Dashboard Live. Streaming data connected.");
    } catch (err) {
      console.error("Fetch Error:", err);
      setStatus(err.message === "Failed to fetch" ? "Network Error / Rate limit hit." : err.message, true);
    } finally {
      setLoading(false);
    }
  }

  // --- Search Engine ---
  let searchTimeout = null;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    if (query.length < 2) { searchDropdown.hidden = true; return; }
    searchTimeout = setTimeout(async () => {
      try {
        const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
        if (!res.ok) return;
        const coins = (await res.json()).coins.slice(0, 6);
        if (!coins || coins.length === 0) { searchDropdown.hidden = true; return; }
        searchDropdown.innerHTML = coins.map(c => `<div class="search-item" data-id="${c.id}"><img src="${c.thumb}" /><span><strong>${c.name}</strong></span><span class="symbol">${c.symbol}</span></div>`).join("");
        searchDropdown.hidden = false;
        document.querySelectorAll(".search-item").forEach(item => item.addEventListener("click", () => {
          addCoin(item.getAttribute("data-id")); searchInput.value = ""; searchDropdown.hidden = true;
        }));
      } catch (err) {}
    }, 350);
  });
  document.addEventListener("click", (e) => { if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) searchDropdown.hidden = true; });

  function addCoin(id) { 
    if (!watchlist.includes(id)) { 
      watchlist.push(id); 
      saveWatchlist(); 
      needsFullRender = true; 
      fetchMarketData(); 
    } 
  }
  
  function removeCoin(id) { 
    watchlist = watchlist.filter(item => item !== id); 
    delete holdings[id]; 
    saveHoldings(); 
    saveWatchlist(); 
    needsFullRender = true; 
    fetchMarketData(); 
  }
  
  sortSelect.addEventListener("change", (e) => { 
    currentSort = e.target.value; 
    localStorage.setItem("pulsevault-sort", currentSort); 
    needsFullRender = true; 
    renderDashboard(); 
  });

  // --- Theme Engine ---
  function applyTheme(theme) {
    const isDark = theme === "dark"; document.body.classList.toggle("dark-mode", isDark); document.body.classList.toggle("light-mode", !isDark);
    if (themeSwitch) themeSwitch.checked = isDark; localStorage.setItem("pulsevault-theme", theme);
    Object.keys(charts).forEach(id => {
      if (charts[id]) {
        const coin = marketData.find(c => c.id === id);
        if (coin) { charts[id].data.datasets[0].borderColor = (coin.price_change_percentage_24h || 0) >= 0 ? (isDark ? "#4ade80" : "#00c853") : (isDark ? "#fb7185" : "#ff1744"); charts[id].update("none"); }
      }
    });
    
    if (modalChartInstance && !modalBackdrop.hidden && currentModalCoin) {
      const activeBtn = document.querySelector(".tf-btn.active");
      if(activeBtn) fetchModalChart(currentModalCoin, activeBtn.getAttribute("data-days"));
    }
    updatePortfolio();
  }

  function initTheme() { applyTheme(localStorage.getItem("pulsevault-theme") || "light"); }
  if (themeSwitch) themeSwitch.addEventListener("change", () => applyTheme(themeSwitch.checked ? "dark" : "light"));

  // --- App Initialization ---
  initTheme();
  fetchGlobalData();
  fetchMarketData(); // This now automatically starts the WebSockets

  // Re-sync heavy data strictly every 2 minutes (Zero rate limit risk)
  setInterval(() => {
    fetchMarketData();
  }, 120000);
});