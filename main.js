// SVG Dimensions
const scaleFactor = 532 / 506;
const courtWidth = 532;
const courtHeight = 476 * scaleFactor;

const xScale = d3.scaleLinear()
    .domain([-250, 250])
    .range([3 * scaleFactor, 532 - 3 * scaleFactor]);

const yScale = d3.scaleLinear()
    .domain([-47.5, 422.5])
    .range([4.5 * scaleFactor, courtHeight - 4.5 * scaleFactor]);

const binSize = courtWidth / 15;

const heatmapColorScale = d3.scaleLinear()
    .domain([0, 0.2, 0.5])
    .range(["#4575b4", "#ffffbf", "#d73027"]);

const deltaColorScale = d3.scaleDiverging(t => d3.interpolateRdYlGn(t))
    .domain([-0.2, 0, 0.2]);

let courtNode = null;

// Available seasons and teams
const SEASONS = ["2023-24", "2024-25"];
const TEAMS = [
    { code: "ATL", name: "Atlanta Hawks" },
    { code: "BKN", name: "Brooklyn Nets" },
    { code: "BOS", name: "Boston Celtics" },
    { code: "CHA", name: "Charlotte Hornets" },
    { code: "CHI", name: "Chicago Bulls" },
    { code: "CLE", name: "Cleveland Cavaliers" },
    { code: "DAL", name: "Dallas Mavericks" },
    { code: "DEN", name: "Denver Nuggets" },
    { code: "DET", name: "Detroit Pistons" },
    { code: "GSW", name: "Golden State Warriors" },
    { code: "HOU", name: "Houston Rockets" },
    { code: "IND", name: "Indiana Pacers" },
    { code: "LAC", name: "LA Clippers" },
    { code: "LAL", name: "Los Angeles Lakers" },
    { code: "MEM", name: "Memphis Grizzlies" },
    { code: "MIA", name: "Miami Heat" },
    { code: "MIL", name: "Milwaukee Bucks" },
    { code: "MIN", name: "Minnesota Timberwolves" },
    { code: "NOP", name: "New Orleans Pelicans" },
    { code: "NYK", name: "New York Knicks" },
    { code: "OKC", name: "Oklahoma City Thunder" },
    { code: "ORL", name: "Orlando Magic" },
    { code: "PHI", name: "Philadelphia 76ers" },
    { code: "PHX", name: "Phoenix Suns" },
    { code: "POR", name: "Portland Trail Blazers" },
    { code: "SAC", name: "Sacramento Kings" },
    { code: "SAS", name: "San Antonio Spurs" },
    { code: "TOR", name: "Toronto Raptors" },
    { code: "UTA", name: "Utah Jazz" },
    { code: "WAS", name: "Washington Wizards" }
];

// Data cache: key = "season_team"
const dataCache = {};

// State for each segment
const segmentState = {
    A: { shots: [], players: new Map(), teammates: new Map(), opponents: new Map(), filteredShots: [], selectedCategory: null, categoryPositions: {} },
    B: { shots: [], players: new Map(), teammates: new Map(), opponents: new Map(), filteredShots: [], selectedCategory: null, categoryPositions: {} }
};

// Select a category in treemap - filters court map and zooms treemap
// 修改後的 selectCategory：分離 Treemap 與 Heatmap 的更新邏輯
function selectCategory(segment, categoryName) {
    const state = segmentState[segment];

    // 1. 切換選取狀態
    if (state.selectedCategory === categoryName) {
        state.selectedCategory = null; // 取消選取 (Back to Overview)
    } else {
        state.selectedCategory = categoryName; // 選取並鑽取 (Drill down)
    }

    // 2. 針對 Treemap：呼叫 "Zoom" (平滑縮放)，而不是 "Draw" (重畫)
    zoomTreemap(segment, state.selectedCategory);

    // 3. 針對 Heatmap：維持 "Draw" (重畫)，因為點位需要重新過濾
    const rangeSlider = segment === 'A' ? sliderA : sliderB;
    const timeRange = rangeSlider ? rangeSlider.value() : (segment === 'A' ? [0, 24] : [24, 48]);

    let displayShots = state.filteredShots;
    if (state.selectedCategory) {
        // 如果有選取類別，Heatmap 只顯示該類別的投籃點
        displayShots = state.filteredShots.filter(d =>
            getShotCategory(d.ACTION_TYPE) === state.selectedCategory
        );
    }

    // 重繪球場圖
    drawHeatmap(`#heatmap-${segment.toLowerCase()}`, displayShots, timeRange, segment);

    // 更新數據面板
    updateOverallStats(segment, displayShots);
    updateStatsTable(segment, displayShots);

    // 更新 Delta 圖
    updateDelta();
}

let sliderA = null;
let sliderB = null;

// Linked highlighting functions
function highlightShotType(segment, shotType) {
    const containerId = `#heatmap-${segment.toLowerCase()}`;
    const svg = d3.select(containerId).select("svg");
    if (!svg.node()) return;

    // Remove existing highlight layer
    svg.selectAll(".highlight-layer").remove();

    if (!shotType) return;

    const filteredShots = segmentState[segment].filteredShots;
    const matchingShots = filteredShots.filter(d => {
        const category = getShotCategory(d.ACTION_TYPE);
        return d.ACTION_TYPE === shotType || category === shotType;
    });

    const highlightGroup = svg.append("g").attr("class", "highlight-layer");

    highlightGroup.selectAll("circle")
        .data(matchingShots)
        .enter().append("circle")
        .attr("cx", d => xScale(d.LOC_X))
        .attr("cy", d => yScale(d.LOC_Y))
        .attr("r", 4)
        .attr("fill", d => d.SHOT_MADE_FLAG === 1 ? "#22c55e" : "#ef4444")
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", 0.9);
}

function clearHighlight(segment) {
    const containerId = `#heatmap-${segment.toLowerCase()}`;
    d3.select(containerId).select("svg").selectAll(".highlight-layer").remove();
}

// Highlight same zone on all other court maps
function highlightZoneOnOtherCourts(sourceSegment, bx, by) {
    const courts = ['heatmap-a', 'heatmap-b', 'heatmap-delta-more', 'heatmap-delta-less'];
    const sourceId = `heatmap-${sourceSegment.toLowerCase()}`;

    // Calculate the center position of the bin
    const centerX = bx * binSize + binSize / 2;
    const centerY = by * binSize + binSize / 2;

    courts.forEach(courtId => {
        if (courtId === sourceId) return; // Skip source court

        const svg = d3.select(`#${courtId}`).select("svg");
        if (!svg.node()) return;

        // Remove existing highlight
        svg.selectAll(".zone-highlight").remove();

        // For delta courts, only highlight if there's data in that zone
        if (courtId.includes('delta')) {
            // Check if there's any element at this position
            const hasData = svg.selectAll("g.delta path").filter(function (d) {
                if (!d) return false;
                const pathBx = Math.floor(d.x / binSize);
                const pathBy = Math.floor(d.y / binSize);
                return pathBx === bx && pathBy === by;
            }).size() > 0;

            if (!hasData) return; // Skip if no data
        }

        // Add highlight circle
        svg.append("circle")
            .attr("class", "zone-highlight")
            .attr("cx", centerX)
            .attr("cy", centerY)
            .attr("r", binSize / 2)
            .attr("fill", "none")
            .attr("stroke", "#FFC857")
            .attr("stroke-width", 3)
            .attr("stroke-dasharray", "5,3")
            .attr("opacity", 0.9);
    });
}

// Highlight only Segment A and B courts (for delta hover)
function highlightZoneOnSegmentCourts(bx, by) {
    const courts = ['heatmap-a', 'heatmap-b'];
    const centerX = bx * binSize + binSize / 2;
    const centerY = by * binSize + binSize / 2;

    courts.forEach(courtId => {
        const svg = d3.select(`#${courtId}`).select("svg");
        if (!svg.node()) return;

        svg.selectAll(".zone-highlight").remove();

        svg.append("circle")
            .attr("class", "zone-highlight")
            .attr("cx", centerX)
            .attr("cy", centerY)
            .attr("r", binSize / 2)
            .attr("fill", "none")
            .attr("stroke", "#FFC857")
            .attr("stroke-width", 3)
            .attr("stroke-dasharray", "5,3")
            .attr("opacity", 0.9);
    });
}

function clearZoneHighlightOnOtherCourts() {
    const courts = ['heatmap-a', 'heatmap-b', 'heatmap-delta-more', 'heatmap-delta-less'];
    courts.forEach(courtId => {
        d3.select(`#${courtId}`).select("svg").selectAll(".zone-highlight").remove();
    });
}

function getTimeElapsed(period, minutes, seconds) {
    let elapsed = 0;
    if (period <= 4) {
        elapsed = (period - 1) * 12 + (12 - minutes) + (60 - seconds) / 60;
    } else {
        elapsed = 48 + (period - 5) * 5 + (5 - minutes) + (60 - seconds) / 60;
    }
    return elapsed;
}

function binData(data, timeDurationMinutes) {
    const bins = {};
    data.forEach(d => {
        const svgX = xScale(d.LOC_X);
        const svgY = yScale(d.LOC_Y);
        const bx = Math.floor(svgX / binSize);
        const by = Math.floor(svgY / binSize);
        const key = `${bx},${by}`;

        if (!bins[key]) {
            bins[key] = {
                bx: bx, by: by,
                x: bx * binSize + binSize / 2,
                y: by * binSize + binSize / 2,
                made: 0, attempts: 0
            };
        }
        bins[key].attempts += 1;
        if (d.SHOT_MADE_FLAG === 1) bins[key].made += 1;
    });

    return Object.values(bins).map(b => {
        b.freq = timeDurationMinutes > 0 ? b.attempts / timeDurationMinutes : 0;
        b.eff = b.made / b.attempts;
        return b;
    });
}

function transformCourt(svgNode) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `matrix(0,${scaleFactor},${scaleFactor},0,0,0)`);
    while (svgNode.firstChild) g.appendChild(svgNode.firstChild);
    svgNode.appendChild(g);
}

function drawHeatmap(containerId, data, timeRange, segment) {
    const container = d3.select(containerId);
    container.selectAll("svg").remove();
    if (!courtNode) return;

    const svgNode = courtNode.cloneNode(true);
    transformCourt(svgNode);

    const svg = d3.select(svgNode)
        .attr("viewBox", `-10 -10 ${courtWidth + 20} ${courtHeight + 20}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

    container.node().appendChild(svgNode);

    const duration = timeRange[1] - timeRange[0];
    const binned = binData(data, duration);
    const sizeScale = d3.scaleSqrt().domain([0, 1.0]).range([0, binSize / 2 - 2]);

    // Create a map for quick lookup
    const binMap = new Map(binned.map(d => [`${d.bx},${d.by}`, d]));

    const group = svg.append("g").attr("class", "heatmap");

    // Draw circles first (visual layer) with animation
    group.selectAll("circle.shot-zone")
        .data(binned)
        .enter().append("circle")
        .attr("class", "shot-zone")
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("r", 0) // Start with 0 radius for animation
        .attr("fill", d => heatmapColorScale(d.eff))
        .attr("opacity", 0)
        .attr("pointer-events", "none")
        .transition()
        .duration(400)
        .delay((d, i) => i * 5) // Staggered animation
        .attr("r", d => sizeScale(d.freq))
        .attr("opacity", 0.8);

    // Generate all possible cells
    const numCols = Math.ceil(courtWidth / binSize);
    const numRows = Math.ceil(courtHeight / binSize);
    const allCells = [];
    for (let bx = 0; bx < numCols; bx++) {
        for (let by = 0; by < numRows; by++) {
            allCells.push({ bx, by });
        }
    }

    // Add invisible rectangular hit areas for ALL cells
    group.selectAll("rect.hit-area")
        .data(allCells)
        .enter().append("rect")
        .attr("class", "hit-area")
        .attr("x", d => d.bx * binSize)
        .attr("y", d => d.by * binSize)
        .attr("width", binSize)
        .attr("height", binSize)
        .attr("fill", "transparent")
        .attr("cursor", "pointer")
        .on("mouseover", (event, d) => {
            const cellData = binMap.get(`${d.bx},${d.by}`);

            // Highlight the circle if exists
            if (cellData) {
                group.selectAll("circle.shot-zone")
                    .filter(c => c.bx === d.bx && c.by === d.by)
                    .attr("stroke", "#FFC857")
                    .attr("stroke-width", 2);

                d3.select("#tooltip").style("opacity", 1)
                    .html(`<div style="font-weight:bold; color:#FFC857;">Shot Zone</div>
                        Freq: ${cellData.freq.toFixed(2)}/min<br>Eff: ${(cellData.eff * 100).toFixed(1)}%<br>
                        <span style="color:#aaa;">(${cellData.made}/${cellData.attempts})</span>`)
                    .style("left", (event.pageX + 15) + "px")
                    .style("top", (event.pageY - 28) + "px");
            } else {
                d3.select("#tooltip").style("opacity", 1)
                    .html(`<div style="font-weight:bold; color:#888;">No shots</div>`)
                    .style("left", (event.pageX + 15) + "px")
                    .style("top", (event.pageY - 28) + "px");
            }

            // Linked highlighting to other court maps
            if (segment) highlightZoneOnOtherCourts(segment, d.bx, d.by);
        })
        .on("mouseout", (event, d) => {
            // Remove highlight from circle
            group.selectAll("circle.shot-zone")
                .filter(c => c.bx === d.bx && c.by === d.by)
                .attr("stroke", null)
                .attr("stroke-width", null);

            d3.select("#tooltip").style("opacity", 0);

            clearZoneHighlightOnOtherCourts();
        });
}

function drawDelta(containerIdMore, containerIdLess, dataA, dataB, rangeA, rangeB) {
    const binsA = binData(dataA, rangeA[1] - rangeA[0]);
    const binsB = binData(dataB, rangeB[1] - rangeB[0]);
    const mapA = new Map(binsA.map(d => [`${d.bx},${d.by}`, d]));
    const mapB = new Map(binsB.map(d => [`${d.bx},${d.by}`, d]));
    const keys = new Set([...mapA.keys(), ...mapB.keys()]);

    const deltaData = [];
    keys.forEach(key => {
        const a = mapA.get(key) || { freq: 0, eff: 0, x: 0, y: 0, bx: 0, by: 0, attempts: 0, made: 0 };
        const b = mapB.get(key) || { freq: 0, eff: 0, x: 0, y: 0, bx: 0, by: 0, attempts: 0, made: 0 };
        const x = a.x || b.x, y = a.y || b.y;
        const bx = a.bx || b.bx, by = a.by || b.by;
        if (x === 0 && y === 0) return;

        // Calculate frequency percentages based on total attempts
        const totalA = dataA.length || 1;
        const totalB = dataB.length || 1;
        const freqPctA = (a.attempts / totalA * 100);
        const freqPctB = (b.attempts / totalB * 100);

        deltaData.push({
            x, y, bx, by, deltaFreq: b.freq - a.freq, deltaEff: b.eff - a.eff,
            freqA: a.freq, freqB: b.freq, effA: a.eff, effB: b.eff,
            attemptsA: a.attempts, madeA: a.made, attemptsB: b.attempts, madeB: b.made,
            freqPctA, freqPctB, totalA, totalB,
            avgFreq: (a.freq + b.freq) / 2
        });
    });

    renderDeltaMap(containerIdMore, deltaData.filter(d => d.deltaFreq > 0));
    renderDeltaMap(containerIdLess, deltaData.filter(d => d.deltaFreq < 0));
}

function renderDeltaMap(containerId, data) {
    const container = d3.select(containerId);
    container.selectAll("svg").remove();
    if (!courtNode) return;

    const svgNode = courtNode.cloneNode(true);
    transformCourt(svgNode);
    const svg = d3.select(svgNode)
        .attr("viewBox", `-10 -10 ${courtWidth + 20} ${courtHeight + 20}`)
        .attr("preserveAspectRatio", "xMidYMid meet");
    container.node().appendChild(svgNode);

    const group = svg.append("g").attr("class", "delta");
    const heightScale = d3.scaleLinear().domain([0, 0.5]).range([10, binSize * 0.5]);
    const widthScale = d3.scaleLinear().domain([0, 2]).range([10, binSize * 0.5]);

    const arrowPath = (w, h, dir) => {
        const sign = dir > 0 ? 1 : -1;
        return `M 0,${-sign * h / 2} L${w / 2},${sign * h / 2} L${-w / 2},${sign * h / 2} Z`;
    };

    // Create a map for quick lookup
    const dataMap = new Map(data.map(d => [`${d.bx},${d.by}`, d]));

    const cells = group.selectAll("g.delta-cell").data(data).enter().append("g")
        .attr("class", "delta-cell")
        .attr("transform", d => `translate(${d.x},${d.y})`);

    cells.append("path")
        .attr("d", d => arrowPath(widthScale(d.avgFreq), heightScale(Math.abs(d.deltaFreq)), d.deltaFreq))
        .attr("fill", d => d.freqA === 0 || d.freqB === 0 ? "#888" : deltaColorScale(d.deltaEff))
        .attr("stroke", "#222").attr("stroke-width", 0.5)
        .attr("pointer-events", "none");

    // Add invisible rectangular hit areas for each cell with data
    group.selectAll("rect.hit-area")
        .data(data)
        .enter().append("rect")
        .attr("class", "hit-area")
        .attr("x", d => d.bx * binSize)
        .attr("y", d => d.by * binSize)
        .attr("width", binSize)
        .attr("height", binSize)
        .attr("fill", "transparent")
        .attr("cursor", "pointer")
        .on("mouseover", (event, d) => {
            // Highlight the hovered cell on delta map
            const centerX = d.bx * binSize + binSize / 2;
            const centerY = d.by * binSize + binSize / 2;
            svg.append("circle")
                .attr("class", "zone-highlight")
                .attr("cx", centerX)
                .attr("cy", centerY)
                .attr("r", binSize / 2)
                .attr("fill", "none")
                .attr("stroke", "#FFC857")
                .attr("stroke-width", 3)
                .attr("stroke-dasharray", "5,3")
                .attr("opacity", 0.9);

            d3.select("#tooltip").style("opacity", 1)
                .html(`
                    <table style="border-collapse: collapse; text-align: center; width: 250px;">
                        <tr>
                            <td style="color: #FF8C42; font-weight: bold; width: 100px;">Segment A</td>
                            <td style="width: 50px;"></td>
                            <td style="color: #41c6ff; font-weight: bold; width: 100px;">Segment B</td>
                        </tr>
                        <tr>
                            <td style="text-align: center;"><div style="width: 30px; height: 30px; margin: 0 auto;"><svg width="30" height="30"><circle cx="15" cy="15" r="${Math.min(12, d.freqPctA * 1.2 + 3)}" fill="#FF8C42"/></svg></div></td>
                            <td></td>
                            <td style="text-align: center;"><div style="width: 30px; height: 30px; margin: 0 auto;"><svg width="30" height="30"><circle cx="15" cy="15" r="${Math.min(12, d.freqPctB * 1.2 + 3)}" fill="#41c6ff"/></svg></div></td>
                        </tr>
                        <tr>
                            <td style="color: #FF8C42;">${d.freqPctA.toFixed(1)}%<br><span style="color:#888;">(${d.attemptsA}/${d.totalA})</span></td>
                            <td style="color: #999;">Frequency</td>
                            <td style="color: #41c6ff;">${d.freqPctB.toFixed(1)}%<br><span style="color:#888;">(${d.attemptsB}/${d.totalB})</span></td>
                        </tr>
                        <tr>
                            <td style="color: #ccc;">${d.attemptsA > 0 ? (d.effA * 100).toFixed(1) : 0}% (${d.madeA}/${d.attemptsA})</td>
                            <td style="color: #999;">FG%</td>
                            <td style="color: #ccc;">${d.attemptsB > 0 ? (d.effB * 100).toFixed(1) : 0}% (${d.madeB}/${d.attemptsB})</td>
                        </tr>
                    </table>
                `)
                .style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");

            // Highlight Segment A and B courts (always show cell highlight)
            highlightZoneOnSegmentCourts(d.bx, d.by);
        })
        .on("mouseout", () => {
            svg.selectAll(".zone-highlight").remove();
            d3.select("#tooltip").style("opacity", 0);
            clearZoneHighlightOnOtherCourts();
        });
}

// Load data for a specific season + team
async function loadTeamData(season, teamCode) {
    const cacheKey = `${season}_${teamCode}`;
    if (dataCache[cacheKey]) return dataCache[cacheKey];

    const url = `data/shots_by_season/${season}_${teamCode}.json`;
    try {
        const data = await d3.json(url);
        data.forEach(d => {
            d.timeElapsed = getTimeElapsed(d.PERIOD, d.MINUTES_REMAINING, d.SECONDS_REMAINING);
        });
        dataCache[cacheKey] = data;
        return data;
    } catch (e) {
        console.warn(`Failed to load ${url}`);
        return [];
    }
}

function extractPlayers(shots) {
    const players = new Map();
    shots.forEach(shot => {
        if (!players.has(shot.PLAYER_ID)) {
            players.set(shot.PLAYER_ID, shot.PLAYER_NAME);
        }
    });
    return players;
}

function extractTeammatesAndOpponents(shots, playerId) {
    const teammates = new Map();
    const opponents = new Map();
    const playerShots = shots.filter(s => s.PLAYER_ID === playerId);

    playerShots.forEach(shot => {
        if (shot.teammates_on_court) {
            shot.teammates_on_court.forEach(tid => {
                if (tid !== playerId) {
                    const tShot = shots.find(s => s.PLAYER_ID === tid);
                    teammates.set(tid, tShot ? tShot.PLAYER_NAME : `Player ${tid}`);
                }
            });
        }
        if (shot.opponents_on_court) {
            shot.opponents_on_court.forEach(oid => {
                const oShot = shots.find(s => s.PLAYER_ID === oid);
                opponents.set(oid, oShot ? oShot.PLAYER_NAME : `Player ${oid}`);
            });
        }
    });
    return { teammates, opponents };
}

function populateSelect(selectId, items, includeAny = false) {
    const select = d3.select(`#${selectId}`);
    select.selectAll("option").remove();
    if (includeAny) select.append("option").attr("value", "").text("-- Any --");
    const sorted = Array.from(items.entries()).sort((a, b) => a[1].localeCompare(b[1]));
    select.selectAll("option.item").data(sorted).enter().append("option")
        .attr("class", "item").attr("value", d => d[0]).text(d => d[1]);
}

function filterShots(shots, playerId, timeRange, teammateOn, teammateOff, opponentOn, opponentOff) {
    let filtered = shots.filter(d => d.PLAYER_ID === playerId);
    filtered = filtered.filter(d => d.timeElapsed >= timeRange[0] && d.timeElapsed < timeRange[1]);
    if (teammateOn) filtered = filtered.filter(d => d.teammates_on_court?.includes(parseInt(teammateOn)));
    if (teammateOff) filtered = filtered.filter(d => !d.teammates_on_court?.includes(parseInt(teammateOff)));
    if (opponentOn) filtered = filtered.filter(d => d.opponents_on_court?.includes(parseInt(opponentOn)));
    if (opponentOff) filtered = filtered.filter(d => !d.opponents_on_court?.includes(parseInt(opponentOff)));
    return filtered;
}

// Classify shot types into categories
function getShotCategory(actionType) {
    const type = (actionType || '').toLowerCase();
    if (type.includes('dunk') || type.includes('slam')) return 'Dunk';
    if (type.includes('layup') || type.includes('finger roll') || type.includes('tip')) return 'Layup';
    if (type.includes('hook')) return 'Hook Shot';
    if (type.includes('float') || type.includes('floater')) return 'Floater';
    // Default to Jump Shot for all jump shots, fadeaways, step backs, pullups, etc.
    return 'Jump Shot';
}

// Aggregate shot data by ACTION_TYPE
function aggregateShotTypes(data) {
    const types = {};
    data.forEach(d => {
        const type = d.ACTION_TYPE || 'Unknown';
        if (!types[type]) {
            types[type] = { name: type, made: 0, attempts: 0, is3pt: d.SHOT_TYPE === '3PT Field Goal' };
        }
        types[type].attempts++;
        if (d.SHOT_MADE_FLAG === 1) types[type].made++;
    });

    return Object.values(types).map(t => ({
        ...t,
        freq: t.attempts / data.length,
        fg: t.made / t.attempts,
        efg: t.is3pt ? (t.made * 1.5) / t.attempts : t.made / t.attempts
    })).sort((a, b) => b.attempts - a.attempts);
}

// Aggregate shot data hierarchically by category
function aggregateShotTypesHierarchical(data) {
    const categories = {};

    data.forEach(d => {
        const actionType = d.ACTION_TYPE || 'Unknown';
        const category = getShotCategory(actionType);
        const is3pt = d.SHOT_TYPE === '3PT Field Goal';

        if (!categories[category]) {
            categories[category] = { name: category, children: {}, made: 0, attempts: 0, is3pt: false };
        }

        if (!categories[category].children[actionType]) {
            categories[category].children[actionType] = { name: actionType, made: 0, attempts: 0, is3pt };
        }

        categories[category].attempts++;
        categories[category].children[actionType].attempts++;
        if (d.SHOT_MADE_FLAG === 1) {
            categories[category].made++;
            categories[category].children[actionType].made++;
        }
    });

    const totalAttempts = data.length || 1;

    return Object.values(categories).map(cat => ({
        name: cat.name,
        made: cat.made,
        attempts: cat.attempts,
        freq: cat.attempts / totalAttempts,
        fg: cat.made / cat.attempts,
        efg: cat.made / cat.attempts, // Simplified for category level
        children: Object.values(cat.children).map(child => ({
            name: child.name,
            made: child.made,
            attempts: child.attempts,
            freq: child.attempts / totalAttempts,
            fg: child.made / child.attempts,
            efg: child.is3pt ? (child.made * 1.5) / child.attempts : child.made / child.attempts
        })).sort((a, b) => b.attempts - a.attempts)
    })).sort((a, b) => b.attempts - a.attempts);
}

// Treemap color scale based on efficiency
const treemapColorScale = d3.scaleLinear()
    .domain([0.3, 0.5, 0.7])
    .range(["#41c6ff", "#FFC857", "#ff6b35"]);

// Draw treemap for shot types (hierarchical)
function drawTreemap(containerId, data, segment) {
    const container = d3.select(containerId);
    container.selectAll("*").remove();

    const hierarchicalData = aggregateShotTypesHierarchical(data);
    if (hierarchicalData.length === 0) return;

    const width = 280;
    const height = 280;

    const svg = container.append("svg")
        .attr("width", width)
        .attr("height", height);

    // Breadcrumb header (hidden by default, shown on drill-down)
    const breadcrumb = svg.append("g")
        .attr("class", "breadcrumb")
        .attr("opacity", 0);

    breadcrumb.append("rect")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", width)
        .attr("height", 20)
        .attr("fill", "#FFC857")
        .attr("rx", 3);

    breadcrumb.append("text")
        .attr("class", "breadcrumb-text")
        .attr("x", 8)
        .attr("y", 14)
        .attr("font-size", "11px")
        .attr("font-weight", "bold")
        .attr("fill", "#111")
        .text("");

    breadcrumb.attr("cursor", "pointer")
        .on("click", () => {
            if (segment) selectCategory(segment, segmentState[segment].selectedCategory);
        });

    // Create hierarchy data with categories
    const root = d3.hierarchy({ name: "root", children: hierarchicalData })
        .sum(d => d.children ? 0 : d.attempts || 0);

    d3.treemap()
        .size([width, height])
        .paddingTop(12)
        .paddingRight(1)
        .paddingBottom(1)
        .paddingLeft(1)
        .paddingInner(2)(root);

    // Draw category groups
    const categories = svg.selectAll("g.category")
        .data(root.children || [])
        .enter().append("g")
        .attr("class", "category");

    // Category background
    categories.append("rect")
        .attr("x", d => d.x0)
        .attr("y", d => d.y0)
        .attr("width", d => Math.max(0, d.x1 - d.x0))
        .attr("height", d => Math.max(0, d.y1 - d.y0))
        .attr("fill", "none");

    // Save category positions for zoom animation
    if (segment) {
        segmentState[segment].categoryPositions = {};
        (root.children || []).forEach(catNode => {
            segmentState[segment].categoryPositions[catNode.data.name] = {
                x0: catNode.x0,
                y0: catNode.y0,
                x1: catNode.x1,
                y1: catNode.y1,
                cx: (catNode.x0 + catNode.x1) / 2,
                cy: (catNode.y0 + catNode.y1) / 2,
                width: catNode.x1 - catNode.x0,
                height: catNode.y1 - catNode.y0
            };
        });
    }

    // Category label with linked highlighting
    categories.append("text")
        .attr("x", d => d.x0 + 3)
        .attr("y", d => d.y0 + 11)
        .attr("fill", "#fff")
        .attr("font-size", "10px")
        .attr("font-weight", "bold")
        .attr("cursor", "pointer")
        .text(d => d.data.name)
        .on("mouseover", (event, d) => {
            if (segment) highlightShotType(segment, d.data.name);
        })
        .on("mouseout", () => {
            if (segment) clearHighlight(segment);
        });

    // Draw child cells (individual shot types)
    const cells = svg.selectAll("g.cell")
        .data(root.leaves())
        .enter().append("g")
        .attr("class", "cell")
        .attr("transform", d => `translate(${d.x0},${d.y0})`);

    cells.append("rect")
        .attr("width", d => Math.max(0, d.x1 - d.x0))
        .attr("height", d => Math.max(0, d.y1 - d.y0))
        .attr("fill", d => treemapColorScale(d.data.efg || 0));

    // Add clip paths to prevent text overflow
    cells.append("clipPath")
        .attr("id", (d, i) => `clip-${containerId.replace('#', '')}-${i}`)
        .append("rect")
        .attr("width", d => Math.max(0, d.x1 - d.x0 - 2))
        .attr("height", d => Math.max(0, d.y1 - d.y0 - 2));

    // Add labels for cells large enough
    cells.each(function (d, i) {
        const cellWidth = d.x1 - d.x0;
        const cellHeight = d.y1 - d.y0;
        const g = d3.select(this);
        const maxChars = Math.floor(cellWidth / 6);

        if (cellWidth > 30 && cellHeight > 20) {
            const shortName = d.data.name
                .replace(' Shot', '')
                .replace('Driving ', '')
                .replace(' Jump', '')
                .replace('Running ', '')
                .substring(0, Math.max(3, maxChars - 1));
            g.append("text")
                .attr("x", 2)
                .attr("y", 11)
                .attr("fill", "#000")
                .attr("font-size", "8px")
                .attr("font-weight", "bold")
                .attr("clip-path", `url(#clip-${containerId.replace('#', '')}-${i})`)
                .text(shortName);

            if (cellHeight > 30) {
                g.append("text")
                    .attr("x", 2)
                    .attr("y", 21)
                    .attr("fill", "#000")
                    .attr("font-size", "7px")
                    .attr("clip-path", `url(#clip-${containerId.replace('#', '')}-${i})`)
                    .text(`${(d.data.efg * 100).toFixed(0)}%`);
            }
        }
    });

    // Tooltips and linked highlighting
    cells.on("mouseover", (event, d) => {
        const parentName = d.parent ? d.parent.data.name : '';
        d3.select("#tooltip").style("opacity", 1)
            .html(`<div style="font-weight:bold; color:#FFC857;">${d.data.name}</div>
                <span style="color:#aaa;">${parentName}</span><br>
                ${d.data.made}/${d.data.attempts} (${(d.data.fg * 100).toFixed(1)}%)<br>
                EFG: ${(d.data.efg * 100).toFixed(1)}%`)
            .style("left", (event.pageX + 15) + "px")
            .style("top", (event.pageY - 28) + "px");

        // Linked highlighting
        if (segment) highlightShotType(segment, d.data.name);
    }).on("mouseout", () => {
        d3.select("#tooltip").style("opacity", 0);
        if (segment) clearHighlight(segment);
    });

    // Click on category label to drill down
    categories.select("text")
        .on("click", (event, d) => {
            event.stopPropagation();
            if (segment) selectCategory(segment, d.data.name);
        });

    // Click on cells to drill down to parent category
    cells.on("click", (event, d) => {
        event.stopPropagation();
        const parentName = d.parent ? d.parent.data.name : null;
        if (segment && parentName) selectCategory(segment, parentName);
    });
}

// 新增：只負責縮放 Treemap 的函式 (不重畫 DOM)
function zoomTreemap(segment, selectedCategory) {
    const containerId = `#treemap-${segment.toLowerCase()}`;
    const svg = d3.select(containerId).select("svg");

    // 固定的畫布大小 (與 drawTreemap 中設定的一致)
    const width = 280;
    const height = 280;

    // 1. 決定新的座標系統 (Domain)
    // 預設為全域 (0 ~ 280)
    let xDomain = [0, width];
    let yDomain = [0, height];

    // 如果有選取類別，則將 Domain 聚焦在該類別的原始範圍
    if (selectedCategory) {
        const pos = segmentState[segment].categoryPositions[selectedCategory];
        if (pos) {
            xDomain = [pos.x0, pos.x1];
            yDomain = [pos.y0, pos.y1];
        }
    }

    // 2. 建立新的比例尺
    const x = d3.scaleLinear().domain(xDomain).range([0, width]);
    const y = d3.scaleLinear().domain(yDomain).range([0, height]);

    // 3. 定義過渡動畫
    const t = svg.transition().duration(100).ease(d3.easeCubicOut);

    // --- 更新 Breadcrumb ---
    const breadcrumb = svg.select("g.breadcrumb");
    if (selectedCategory) {
        breadcrumb.select(".breadcrumb-text").text(`← ${selectedCategory}`);
        breadcrumb.transition(t).attr("opacity", 1);
    } else {
        breadcrumb.transition(t).attr("opacity", 0);
    }

    // --- 更新所有 Cell (子矩形) ---
    // 我們需要同時更新 group 的位置、內部的 rect 大小、以及 clipPath

    const cells = svg.selectAll("g.cell");

    // A. 移動 Group 位置
    cells.transition(t)
        .attr("transform", d => `translate(${x(d.x0)},${y(d.y0)})`);

    // B. 調整 Rect 大小
    cells.select("rect")
        .transition(t)
        .attr("width", d => Math.max(0, x(d.x1) - x(d.x0)))
        .attr("height", d => Math.max(0, y(d.y1) - y(d.y0)));

    // C. 調整 ClipPath (文字裁切範圍)，否則放大後文字還是會被原本的小框框切掉
    cells.select("clipPath rect")
        .transition(t)
        .attr("width", d => Math.max(0, x(d.x1) - x(d.x0) - 2))
        .attr("height", d => Math.max(0, y(d.y1) - y(d.y0) - 2));

    // D. 控制文字顯示/隱藏
    // 當矩形放大後，原本因為太小而隱藏的文字現在可以顯示了
    cells.each(function (d) {
        const cellWidth = x(d.x1) - x(d.x0);
        const cellHeight = y(d.y1) - y(d.y0);
        const g = d3.select(this);

        // 簡單的顯示邏輯：夠大就顯示
        const showText = cellWidth > 30 && cellHeight > 20;
        const showPercent = showText && cellHeight > 30;

        // 標題
        g.select("text").filter((d, i, nodes) => i === 0) // 假設第一個 text 是標題
            .transition(t)
            .attr("opacity", showText ? 1 : 0);

        // 百分比 (如果有第二個 text)
        g.selectAll("text").filter((d, i) => i > 0)
            .transition(t)
            .attr("opacity", showPercent ? 1 : 0);
    });

    // --- 更新 Category (大類別背景與標籤) ---
    const categories = svg.selectAll("g.category");

    // 更新大類別框線/背景
    categories.select("rect")
        .transition(t)
        .attr("x", d => x(d.x0))
        .attr("y", d => y(d.y0))
        .attr("width", d => Math.max(0, x(d.x1) - x(d.x0)))
        .attr("height", d => Math.max(0, y(d.y1) - y(d.y0)));

    // 更新大類別標籤位置
    categories.select("text")
        .transition(t)
        .attr("x", d => x(d.x0) + 3)
        .attr("y", d => y(d.y0) + 11)
        .attr("opacity", d => {
            // 如果選取了某個類別，我們通常希望隱藏所有大標籤，或者只顯示當前的
            // 這裡做一個簡單處理：如果有選取 (Drill-down)，淡出所有大標籤，讓視角專注在子項目
            return selectedCategory ? 0 : 1;
        });
}

// Amcharts-style smooth zoom treemap with recalculated layout on drill-down
function drawTreemapWithSelection(containerId, data, segment, selectedCategory) {
    const container = d3.select(containerId);
    const width = 280;
    const height = 280;
    const duration = 600; // Slightly longer for smoother feel
    const headerHeight = 24;

    const hierarchicalData = aggregateShotTypesHierarchical(data);
    if (hierarchicalData.length === 0) return;

    // Always clear and redraw for clean state
    container.selectAll("*").remove();

    const svg = container.append("svg")
        .attr("width", width)
        .attr("height", height)
        .style("overflow", "hidden");

    // Build full treemap layout (for reference positions)
    const fullRoot = d3.hierarchy({ name: "root", children: hierarchicalData })
        .sum(d => d.children ? 0 : d.attempts || 0);

    d3.treemap()
        .size([width, height])
        .paddingTop(14)
        .paddingRight(1)
        .paddingBottom(1)
        .paddingLeft(1)
        .paddingInner(2)(fullRoot);

    const categoryNodes = fullRoot.children || [];

    // Store positions for reference
    if (segment && segmentState[segment]) {
        segmentState[segment].categoryPositions = {};
        categoryNodes.forEach(cat => {
            segmentState[segment].categoryPositions[cat.data.name] = {
                x0: cat.x0, y0: cat.y0, x1: cat.x1, y1: cat.y1
            };
        });
    }

    if (selectedCategory) {
        // === DRILL-DOWN VIEW ===
        const selectedCatData = hierarchicalData.find(c => c.name === selectedCategory);
        if (!selectedCatData || !selectedCatData.children) return;

        // Add breadcrumb header first
        const header = svg.append("g").attr("class", "breadcrumb");

        header.append("rect")
            .attr("x", 0).attr("y", 0)
            .attr("width", width).attr("height", headerHeight)
            .attr("fill", "#FFC857")
            .attr("rx", 3);

        header.append("text")
            .attr("x", 8).attr("y", 16)
            .attr("font-size", "12px")
            .attr("font-weight", "bold")
            .attr("fill", "#111")
            .text(`← ${selectedCategory}`);

        header.attr("cursor", "pointer")
            .on("click", () => selectCategory(segment, selectedCategory));

        // Build NEW treemap layout for children only, filling the remaining space
        const childRoot = d3.hierarchy({ name: selectedCategory, children: selectedCatData.children })
            .sum(d => d.attempts || 0);

        d3.treemap()
            .size([width, height - headerHeight])
            .paddingOuter(2)
            .paddingInner(2)(childRoot);

        const childLeaves = childRoot.leaves();

        // Find original positions from full layout
        const selectedCatNode = categoryNodes.find(c => c.data.name === selectedCategory);
        const origLeaves = selectedCatNode ? selectedCatNode.leaves() : [];
        const origPosMap = new Map();
        origLeaves.forEach(leaf => {
            origPosMap.set(leaf.data.name, { x0: leaf.x0, y0: leaf.y0, x1: leaf.x1, y1: leaf.y1 });
        });

        // Draw cells with animation from original position to new position
        const cellsGroup = svg.append("g")
            .attr("class", "cells")
            .attr("transform", `translate(0, ${headerHeight})`);

        childLeaves.forEach(leaf => {
            const newX = leaf.x0;
            const newY = leaf.y0;
            const newW = leaf.x1 - leaf.x0;
            const newH = leaf.y1 - leaf.y0;

            // Get original position (relative to category origin)
            const orig = origPosMap.get(leaf.data.name);
            let startX = newX, startY = newY, startW = newW * 0.3, startH = newH * 0.3;
            if (orig && selectedCatNode) {
                // Calculate relative position within category, then scale
                const catX0 = selectedCatNode.x0;
                const catY0 = selectedCatNode.y0;
                const catW = selectedCatNode.x1 - selectedCatNode.x0;
                const catH = selectedCatNode.y1 - selectedCatNode.y0;

                // Start from scaled-down original position
                startX = ((orig.x0 - catX0) / catW) * width;
                startY = ((orig.y0 - catY0) / catH) * (height - headerHeight);
                startW = ((orig.x1 - orig.x0) / catW) * width;
                startH = ((orig.y1 - orig.y0) / catH) * (height - headerHeight);
            }

            const cellGroup = cellsGroup.append("g")
                .attr("class", "cell")
                .attr("transform", `translate(${startX}, ${startY})`);

            const rect = cellGroup.append("rect")
                .attr("width", startW)
                .attr("height", startH)
                .attr("fill", treemapColorScale(leaf.data.efg || 0))
                .attr("stroke", "#222")
                .attr("stroke-width", 0.5)
                .attr("opacity", 0.3);

            // Animate to final position
            cellGroup.transition()
                .duration(duration)
                .ease(d3.easeCubicOut)
                .attr("transform", `translate(${newX}, ${newY})`);

            rect.transition()
                .duration(duration)
                .ease(d3.easeCubicOut)
                .attr("width", newW)
                .attr("height", newH)
                .attr("opacity", 1);

            // Add labels after animation
            setTimeout(() => {
                if (newW > 35 && newH > 22) {
                    const shortName = leaf.data.name
                        .replace(' Shot', '').replace('Driving ', '')
                        .replace(' Jump', '').replace('Running ', '')
                        .substring(0, Math.floor(newW / 5.5));

                    cellGroup.append("text")
                        .attr("x", 3).attr("y", 12)
                        .attr("font-size", "9px")
                        .attr("font-weight", "bold")
                        .attr("fill", "#000")
                        .attr("opacity", 0)
                        .text(shortName)
                        .transition()
                        .duration(200)
                        .attr("opacity", 1);

                    if (newH > 35) {
                        cellGroup.append("text")
                            .attr("x", 3).attr("y", 24)
                            .attr("font-size", "8px")
                            .attr("fill", "#000")
                            .attr("opacity", 0)
                            .text(`${(leaf.data.efg * 100).toFixed(0)}% EFG`)
                            .transition()
                            .duration(200)
                            .attr("opacity", 1);
                    }

                    if (newH > 48) {
                        cellGroup.append("text")
                            .attr("x", 3).attr("y", 36)
                            .attr("font-size", "8px")
                            .attr("fill", "#333")
                            .attr("opacity", 0)
                            .text(`${leaf.data.made}/${leaf.data.attempts}`)
                            .transition()
                            .duration(200)
                            .attr("opacity", 1);
                    }
                }
            }, duration * 0.7);

            // Tooltip and highlighting
            cellGroup
                .attr("cursor", "pointer")
                .on("mouseover", (event) => {
                    rect.attr("stroke", "#FFC857").attr("stroke-width", 2);
                    d3.select("#tooltip").style("opacity", 1)
                        .html(`<div style="font-weight:bold; color:#FFC857;">${leaf.data.name}</div>
                            <span style="color:#aaa;">${selectedCategory}</span><br>
                            ${leaf.data.made}/${leaf.data.attempts} (${(leaf.data.fg * 100).toFixed(1)}%)<br>
                            EFG: ${(leaf.data.efg * 100).toFixed(1)}%`)
                        .style("left", (event.pageX + 15) + "px")
                        .style("top", (event.pageY - 28) + "px");
                    if (segment) highlightShotType(segment, leaf.data.name);
                })
                .on("mouseout", () => {
                    rect.attr("stroke", "#222").attr("stroke-width", 0.5);
                    d3.select("#tooltip").style("opacity", 0);
                    if (segment) clearHighlight(segment);
                });
        });

    } else {
        // === OVERVIEW (ALL CATEGORIES) ===
        const baseGroup = svg.append("g").attr("class", "treemap-base");

        categoryNodes.forEach(catNode => {
            const catWidth = catNode.x1 - catNode.x0;
            const catHeight = catNode.y1 - catNode.y0;

            const catGroup = baseGroup.append("g")
                .attr("class", "category")
                .attr("data-name", catNode.data.name)
                .attr("cursor", "pointer")
                .on("click", () => selectCategory(segment, catNode.data.name));

            // Category background
            catGroup.append("rect")
                .attr("class", "cat-bg")
                .attr("x", catNode.x0)
                .attr("y", catNode.y0)
                .attr("width", catWidth)
                .attr("height", catHeight)
                .attr("fill", "rgba(30,30,30,0.5)")
                .attr("stroke", "#444")
                .attr("stroke-width", 1);

            // Category label
            catGroup.append("text")
                .attr("class", "cat-label")
                .attr("x", catNode.x0 + 4)
                .attr("y", catNode.y0 + 11)
                .attr("fill", "#fff")
                .attr("font-size", "10px")
                .attr("font-weight", "bold")
                .text(catNode.data.name);

            // Draw cells with entrance animation
            catNode.leaves().forEach((leaf, i) => {
                const cellWidth = leaf.x1 - leaf.x0;
                const cellHeight = leaf.y1 - leaf.y0;

                const cellGroup = catGroup.append("g")
                    .attr("class", "cell")
                    .attr("transform", `translate(${leaf.x0},${leaf.y0})`);

                cellGroup.append("rect")
                    .attr("width", 0)
                    .attr("height", 0)
                    .attr("fill", treemapColorScale(leaf.data.efg || 0))
                    .attr("stroke", "#222")
                    .attr("stroke-width", 0.5)
                    .transition()
                    .duration(400)
                    .delay(i * 15)
                    .ease(d3.easeCubicOut)
                    .attr("width", cellWidth)
                    .attr("height", cellHeight);

                if (cellWidth > 25 && cellHeight > 18) {
                    const shortName = leaf.data.name
                        .replace(' Shot', '').replace('Driving ', '')
                        .replace(' Jump', '').replace('Running ', '')
                        .substring(0, Math.floor(cellWidth / 5));

                    cellGroup.append("text")
                        .attr("x", 2).attr("y", 10)
                        .attr("font-size", "7px")
                        .attr("font-weight", "bold")
                        .attr("fill", "#000")
                        .attr("opacity", 0)
                        .transition()
                        .delay(300 + i * 15)
                        .attr("opacity", 1)
                        .text(shortName);

                    if (cellHeight > 28) {
                        cellGroup.append("text")
                            .attr("x", 2).attr("y", 19)
                            .attr("font-size", "6px")
                            .attr("fill", "#000")
                            .attr("opacity", 0)
                            .transition()
                            .delay(300 + i * 15)
                            .attr("opacity", 1)
                            .text(`${(leaf.data.efg * 100).toFixed(0)}%`);
                    }
                }

                cellGroup
                    .on("mouseover", (event) => {
                        d3.select("#tooltip").style("opacity", 1)
                            .html(`<div style="font-weight:bold; color:#FFC857;">${leaf.data.name}</div>
                                <span style="color:#aaa;">${catNode.data.name}</span><br>
                                ${leaf.data.made}/${leaf.data.attempts} (${(leaf.data.fg * 100).toFixed(1)}%)<br>
                                EFG: ${(leaf.data.efg * 100).toFixed(1)}%`)
                            .style("left", (event.pageX + 15) + "px")
                            .style("top", (event.pageY - 28) + "px");
                        if (segment) highlightShotType(segment, leaf.data.name);
                    })
                    .on("mouseout", () => {
                        d3.select("#tooltip").style("opacity", 0);
                        if (segment) clearHighlight(segment);
                    });
            });
        });
    }
}

// Update overall stats summary
function updateOverallStats(segment, data) {
    const totalAttempts = data.length;
    const totalMade = data.filter(d => d.SHOT_MADE_FLAG === 1).length;
    const fg = totalAttempts > 0 ? (totalMade / totalAttempts * 100).toFixed(1) : 0;

    // Calculate EFG
    let efgPoints = 0;
    data.forEach(d => {
        if (d.SHOT_MADE_FLAG === 1) {
            efgPoints += d.SHOT_TYPE === '3PT Field Goal' ? 1.5 : 1;
        }
    });
    const efg = totalAttempts > 0 ? (efgPoints / totalAttempts * 100).toFixed(1) : 0;

    d3.select(`#overall-${segment.toLowerCase()}`)
        .text(`${totalMade}/${totalAttempts} (${fg}%) ${efg} efg%`);
}

// Update stats table
function updateStatsTable(segment, data) {
    const tbody = d3.select(`#stats-table-${segment.toLowerCase()} tbody`);
    tbody.selectAll("tr").remove();

    const shotTypes = aggregateShotTypes(data);
    const maxFreq = d3.max(shotTypes, d => d.freq) || 1;

    shotTypes.forEach(st => {
        const row = tbody.append("tr")
            .attr("data-shot-type", st.name)
            .style("cursor", "pointer");
        const barColor = treemapColorScale(st.efg || 0);
        row.append("td").text(st.name.replace(' Shot', ''));
        row.append("td").html(`<span class="freq-bar" style="width: ${st.freq / maxFreq * 60}px; background: ${barColor};"></span>`);
        row.append("td").text(`${(st.freq * 100).toFixed(1)}%`);
        row.append("td").text(`${st.made}/${st.attempts}`);
        row.append("td").text(`${(st.fg * 100).toFixed(1)}%`);
        row.append("td").text(`${(st.efg * 100).toFixed(1)} efg%`);

        // Linked highlighting
        row.on("mouseover", () => {
            row.style("background-color", "rgba(255, 200, 87, 0.2)");
            highlightShotType(segment, st.name);
        }).on("mouseout", () => {
            row.style("background-color", null);
            clearHighlight(segment);
        });
    });
}

function updateSegmentTitle(segment) {
    const season = d3.select(`#seasonSelect${segment}`).property("value");
    const teamCode = d3.select(`#teamSelect${segment}`).property("value");
    const playerSelect = d3.select(`#playerSelect${segment}`);
    const playerName = playerSelect.node()?.selectedOptions[0]?.text || "";

    // Find team name from code
    const team = TEAMS.find(t => t.code === teamCode);
    const teamName = team ? team.code : teamCode;

    let treemapInfo = "-- Select --";
    if (season && teamName && playerName) {
        treemapInfo = `${season} ${teamName} - ${playerName}`;
    } else if (season && teamName) {
        treemapInfo = `${season} ${teamName}`;
    }

    // Only update treemap info, not the h3 title
    d3.select(`#treemap-info-${segment.toLowerCase()}`).text(treemapInfo);
}

async function updateSegmentA() {
    const season = d3.select("#seasonSelectA").property("value");
    const team = d3.select("#teamSelectA").property("value");
    const playerId = parseInt(d3.select("#playerSelectA").property("value"));
    const rangeA = sliderA ? sliderA.value() : [0, 24];

    if (!season || !team || !playerId) return;

    const shots = await loadTeamData(season, team);
    const filtered = filterShots(shots, playerId, rangeA,
        d3.select("#teammateOnA").property("value"),
        d3.select("#teammateOffA").property("value"),
        d3.select("#opponentOnA").property("value"),
        d3.select("#opponentOffA").property("value"));

    segmentState.A.filteredShots = filtered;
    segmentState.A.selectedCategory = null; // Reset category selection when data changes

    drawHeatmap("#heatmap-a", filtered, rangeA, 'A');
    drawTreemap("#treemap-a", filtered, 'A');
    updateOverallStats('A', filtered);
    updateStatsTable('A', filtered);
    updateSegmentTitle('A');
    updateDelta();
}

async function updateSegmentB() {
    const season = d3.select("#seasonSelectB").property("value");
    const team = d3.select("#teamSelectB").property("value");
    const playerId = parseInt(d3.select("#playerSelectB").property("value"));
    const rangeB = sliderB ? sliderB.value() : [24, 48];

    if (!season || !team || !playerId) return;

    const shots = await loadTeamData(season, team);
    const filtered = filterShots(shots, playerId, rangeB,
        d3.select("#teammateOnB").property("value"),
        d3.select("#teammateOffB").property("value"),
        d3.select("#opponentOnB").property("value"),
        d3.select("#opponentOffB").property("value"));

    segmentState.B.filteredShots = filtered;
    segmentState.B.selectedCategory = null; // Reset category selection when data changes

    drawHeatmap("#heatmap-b", filtered, rangeB, 'B');
    drawTreemap("#treemap-b", filtered, 'B');
    updateOverallStats('B', filtered);
    updateStatsTable('B', filtered);
    updateSegmentTitle('B');
    updateDelta();
}

async function updateDelta() {
    const seasonA = d3.select("#seasonSelectA").property("value");
    const teamA = d3.select("#teamSelectA").property("value");
    const playerIdA = parseInt(d3.select("#playerSelectA").property("value"));
    const rangeA = sliderA ? sliderA.value() : [0, 24];

    const seasonB = d3.select("#seasonSelectB").property("value");
    const teamB = d3.select("#teamSelectB").property("value");
    const playerIdB = parseInt(d3.select("#playerSelectB").property("value"));
    const rangeB = sliderB ? sliderB.value() : [24, 48];

    if (!seasonA || !teamA || !playerIdA || !seasonB || !teamB || !playerIdB) return;

    const shotsA = await loadTeamData(seasonA, teamA);
    const shotsB = await loadTeamData(seasonB, teamB);

    const filteredA = filterShots(shotsA, playerIdA, rangeA,
        d3.select("#teammateOnA").property("value"),
        d3.select("#teammateOffA").property("value"),
        d3.select("#opponentOnA").property("value"),
        d3.select("#opponentOffA").property("value"));

    const filteredB = filterShots(shotsB, playerIdB, rangeB,
        d3.select("#teammateOnB").property("value"),
        d3.select("#teammateOffB").property("value"),
        d3.select("#opponentOnB").property("value"),
        d3.select("#opponentOffB").property("value"));

    // Apply category filter if selected
    let deltaA = filteredA;
    let deltaB = filteredB;

    if (segmentState.A.selectedCategory) {
        deltaA = filteredA.filter(d => getShotCategory(d.ACTION_TYPE) === segmentState.A.selectedCategory);
    }
    if (segmentState.B.selectedCategory) {
        deltaB = filteredB.filter(d => getShotCategory(d.ACTION_TYPE) === segmentState.B.selectedCategory);
    }

    drawDelta("#heatmap-delta-more", "#heatmap-delta-less", deltaA, deltaB, rangeA, rangeB);
}

// Handle team change (load team data, populate players)
async function onTeamChange(segment) {
    const season = d3.select(`#seasonSelect${segment}`).property("value");
    const team = d3.select(`#teamSelect${segment}`).property("value");

    if (!season || !team) return;

    const shots = await loadTeamData(season, team);
    const players = extractPlayers(shots);
    segmentState[segment].shots = shots;
    segmentState[segment].players = players;

    populateSelect(`playerSelect${segment}`, players);

    // Set default player to LeBron James if available
    const LEBRON_ID = 2544;
    if (team === "LAL" && players.has(LEBRON_ID)) {
        d3.select(`#playerSelect${segment}`).property("value", LEBRON_ID);
    }

    // Clear filters
    ["teammateOn", "teammateOff", "opponentOn", "opponentOff"].forEach(prefix => {
        const select = d3.select(`#${prefix}${segment}`);
        select.selectAll("option").remove();
        select.append("option").attr("value", "").text("-- Any --");
    });

    if (players.size > 0) await onPlayerChange(segment);
}

async function onPlayerChange(segment) {
    const playerId = parseInt(d3.select(`#playerSelect${segment}`).property("value"));
    if (!playerId) return;

    const shots = segmentState[segment].shots;
    const { teammates, opponents } = extractTeammatesAndOpponents(shots, playerId);

    populateSelect(`teammateOn${segment}`, teammates, true);
    populateSelect(`teammateOff${segment}`, teammates, true);
    populateSelect(`opponentOn${segment}`, opponents, true);
    populateSelect(`opponentOff${segment}`, opponents, true);

    if (segment === 'A') await updateSegmentA();
    else await updateSegmentB();
}

// Initialize
d3.xml("court.svg").then(function (xml) {
    courtNode = xml.documentElement;

    // Populate season and team selects
    SEASONS.forEach(season => {
        d3.select("#seasonSelectA").append("option").attr("value", season).text(season);
        d3.select("#seasonSelectB").append("option").attr("value", season).text(season);
    });

    TEAMS.forEach(team => {
        d3.select("#teamSelectA").append("option").attr("value", team.code).text(team.name);
        d3.select("#teamSelectB").append("option").attr("value", team.code).text(team.name);
    });

    // Set defaults
    d3.select("#seasonSelectA").property("value", "2024-25");
    d3.select("#seasonSelectB").property("value", "2024-25");
    d3.select("#teamSelectA").property("value", "LAL");
    d3.select("#teamSelectB").property("value", "LAL");

    // Sliders
    const sliderWidth = 300;
    const xScaleSlider = d3.scaleLinear().domain([0, 48]).range([0, sliderWidth]);

    sliderA = d3.sliderBottom(xScaleSlider).step(1).tickFormat(d => d + "m")
        .tickValues([0, 12, 24, 36, 48]).default([0, 24]).fill('#FFC857');
    sliderB = d3.sliderBottom(xScaleSlider).step(1).tickFormat(d => d + "m")
        .tickValues([0, 12, 24, 36, 48]).default([24, 48]).fill('#FFC857');

    d3.select('#slider-time-a').append('svg').attr('width', sliderWidth + 50).attr('height', 50)
        .append('g').attr('transform', 'translate(25,10)').call(sliderA);
    d3.select('#slider-time-b').append('svg').attr('width', sliderWidth + 50).attr('height', 50)
        .append('g').attr('transform', 'translate(25,10)').call(sliderB);

    // Event handlers
    d3.select("#seasonSelectA").on("change", () => onTeamChange('A'));
    d3.select("#seasonSelectB").on("change", () => onTeamChange('B'));
    d3.select("#teamSelectA").on("change", () => onTeamChange('A'));
    d3.select("#teamSelectB").on("change", () => onTeamChange('B'));
    d3.select("#playerSelectA").on("change", () => onPlayerChange('A'));
    d3.select("#playerSelectB").on("change", () => onPlayerChange('B'));

    ["teammateOnA", "teammateOffA", "opponentOnA", "opponentOffA"].forEach(id => {
        d3.select(`#${id}`).on("change", updateSegmentA);
    });
    ["teammateOnB", "teammateOffB", "opponentOnB", "opponentOffB"].forEach(id => {
        d3.select(`#${id}`).on("change", updateSegmentB);
    });

    sliderA.on('onchange', updateSegmentA);
    sliderB.on('onchange', updateSegmentB);

    // Period quick-select button handlers
    d3.selectAll('.period-buttons').each(function () {
        const segment = d3.select(this).attr('data-segment');
        const slider = segment === 'A' ? sliderA : sliderB;
        const updateFn = segment === 'A' ? updateSegmentA : updateSegmentB;

        d3.select(this).selectAll('.period-btn').on('click', function () {
            const range = d3.select(this).attr('data-range').split(',').map(Number);
            slider.value(range);

            // Update active state
            d3.select(this.parentNode).selectAll('.period-btn').classed('active', false);
            d3.select(this).classed('active', true);

            updateFn();
        });
    });

    d3.select("#reset-btn").on("click", () => {
        sliderA.value([0, 24]);
        sliderB.value([24, 48]);

        // Update active states for period buttons
        d3.selectAll('.period-buttons[data-segment="A"] .period-btn').classed('active', false);
        d3.select('.period-buttons[data-segment="A"] .period-btn[data-range="0,24"]').classed('active', true);
        d3.selectAll('.period-buttons[data-segment="B"] .period-btn').classed('active', false);
        d3.select('.period-buttons[data-segment="B"] .period-btn[data-range="24,48"]').classed('active', true);

        updateSegmentA();
        updateSegmentB();
    });

    // Initial load
    onTeamChange('A');
    onTeamChange('B');

}).catch(console.error);