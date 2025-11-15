// ===== Utilities =====
async function fetchCsvOrNull(path){
  try{ const res = await fetch(path, {cache:'no-store'}); if(!res.ok) return null; return await res.text(); }
  catch(e){ return null; }
}
function parseCsv(text){
  const lines = text.trim().split(/\r?\n/); const headers = lines.shift().split(',');
  return lines.map(line=>{ const parts=line.split(','); const o={}; headers.forEach((h,i)=> o[h.trim()]=parts[i]?.trim()??''); return o; });
}
function toCsv(rows){
  if(!rows.length) return ''; const headers = Object.keys(rows[0]);
  const out = [headers.join(',')]; rows.forEach(r=> out.push(headers.map(h=> r[h]).join(','))); return out.join('\\n');
}
function download(filename, text){
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:'text/plain'})); a.download=filename; document.body.appendChild(a); a.click(); a.remove();
}
function downloadPngFromChart(chart, filename){
  const url = chart.toBase64Image('image/png', 1.0); const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
}

// ===== Synthetic Data (fallback) =====
const HOURS = [...Array(24).keys()];

function generateDayData(scenario='baseline'){
  const solar=[], wind=[], demand=[]; let soc=55; const socArr=[], battFlow=[];
  for(let h=0; h<24; h++){
    let s=0; if(h>=6 && h<=18){ const x=(h-12)/6; s=Math.max(0,(1-x*x))*450; if(scenario==='cloudy') s*=0.55; if(scenario==='windy') s*=0.9; }
    let w=180 + 80*Math.sin(h/3) + 60*Math.cos(h/2) + (Math.random()*20-10); if(scenario==='windy') w*=1.3; if(scenario==='cloudy') w*=0.95; w=Math.max(60, Math.min(420, w));
    let d=380 + 90*Math.sin((h-7)/2) + 140*Math.sin((h-18)/2) + (Math.random()*40-20); if(scenario==='peak') d*=1.2; d=Math.max(320, Math.min(900, d));
    solar.push(Math.round(s)); wind.push(Math.round(w)); demand.push(Math.round(d));
  }
  const gas=[]; const battMaxKW=300, capacityKWh=2000; let energy=capacityKWh*(soc/100);
  for(let h=0; h<24; h++){
    const renew=solar[h]+wind[h]; const deficit=demand[h]-renew; let flow=0;
    if(deficit>0){ const canDis=Math.min(battMaxKW,deficit); const energyAvail=energy; const maxDis=Math.min(canDis,energyAvail); flow=-maxDis; energy-=Math.max(0,-flow); }
    else { const canCh=Math.min(battMaxKW,-deficit); const room=capacityKWh-energy; const maxCh=Math.min(canCh,room); flow=maxCh; energy+=Math.max(0,flow); }
    energy=Math.max(0,Math.min(capacityKWh,energy));
    const gasFill=Math.max(0, demand[h] - (solar[h]+wind[h] + Math.max(0, -flow)));
    gas.push(Math.round(gasFill)); battFlow.push(Math.round(flow)); soc=(energy/capacityKWh)*100; socArr.push(Math.round(soc));
  }
  return {solar, wind, gas, demand, battFlow, soc: socArr};
}
function generateWeekData(){
  const scenarios=['baseline','cloudy','windy','baseline','peak','baseline','baseline']; return scenarios.map(sc=> generateDayData(sc));
}

// ===== Factors & KPIs =====
const factors = { efGas:0.45, cSolar:0.05, cWind:0.05, cGas:0.20 };
function computeKPIs(day, f=factors){
  const {solar, wind, gas, demand}=day;
  const totalSupply=solar.reduce((a,c)=>a+c,0)+wind.reduce((a,c)=>a+c,0)+gas.reduce((a,c)=>a+c,0);
  const renewables=solar.reduce((a,c)=>a+c,0)+wind.reduce((a,c)=>a+c,0);
  const share= totalSupply>0 ? (renewables/totalSupply)*100 : 0;
  const gasNoRen=demand.reduce((a,c)=>a+c,0); const gasActual=gas.reduce((a,c)=>a+c,0);
  const avoided=Math.max(0, (gasNoRen-gasActual)*f.efGas);
  const cost = solar.reduce((a,c)=>a+c,0)*f.cSolar + wind.reduce((a,c)=>a+c,0)*f.cWind + gasActual*f.cGas;
  const peak = Math.max(...demand);
  return {renewablesShare:share, co2AvoidedKg:avoided, cost, peakDemand:peak};
}

// ===== Anomaly Scoring =====
function rollingMedian(arr, win=5){
  const half = Math.floor(win/2); const out = Array(arr.length).fill(0);
  for(let i=0;i<arr.length;i++){
    const lo = Math.max(0, i-half); const hi = Math.min(arr.length, i+half+1);
    const seg = arr.slice(lo, hi).slice().sort((a,b)=>a-b);
    const mid = Math.floor(seg.length/2);
    out[i] = seg.length%2 ? seg[mid] : (seg[mid-1]+seg[mid])/2;
  }
  return out;
}
function mad(arr, med){
  const dev = arr.map((v,i)=> Math.abs(v - med[i]));
  const mmed = rollingMedian(dev, 5);
  return mmed.map(v=> v*1.4826 + 1e-6);
}
function robustZ(arr){
  const med = rollingMedian(arr, 5);
  const madv = mad(arr, med);
  return arr.map((v,i)=> (v - med[i]) / madv[i]);
}
function diffAbs(arr){ const out=[0]; for(let i=1;i<arr.length;i++) out.push(Math.abs(arr[i]-arr[i-1])); return out; }

function computeAnomalyScore(day){
  const {solar, wind, gas, demand, battFlow, soc} = day;
  const discharge = battFlow.map(v=> v<0 ? -v : 0);
  const supply = solar.map((v,i)=> v + wind[i] + discharge[i] + gas[i]);
  const residual = demand.map((v,i)=> v - supply[i]);
  const rzDemand = robustZ(demand).map(Math.abs);
  const rzSolar  = robustZ(solar).map(v=> Math.max(0, -v));
  const rzWind   = robustZ(wind).map(v=> Math.max(0, -v));
  const rzGas    = robustZ(gas).map(v=> Math.max(0, v));
  const rzResid  = robustZ(residual).map(Math.abs);
  const socDrops = diffAbs(soc).map((d,i)=> (i>0 && (soc[i]-soc[i-1] < -8)) ? Math.abs(soc[i]-soc[i-1])/5 : 0);

  const score = demand.map((_,i)=>
    0.9*rzDemand[i] + 0.8*rzResid[i] + 0.7*rzGas[i] + 0.6*rzSolar[i] + 0.5*rzWind[i] + 0.8*socDrops[i]
  );

  const contribs = demand.map((_,i)=> ({
    demand: + (0.9*rzDemand[i]).toFixed(2),
    residual: + (0.8*rzResid[i]).toFixed(2),
    gas: + (0.7*rzGas[i]).toFixed(2),
    solarDip: + (0.6*rzSolar[i]).toFixed(2),
    windDip: + (0.5*rzWind[i]).toFixed(2),
    socDrop: + (0.8*socDrops[i]).toFixed(2)
  }));

  return { score, contribs, residual };
}

// ===== Charts =====
let supplyDemandChart, genMixChart, socChart, battFlowChart, pastComparisonChart, anomalyScoreChart;

function makeCharts(day, weekDays, anom){
  const labels = HOURS.map(h=> `${String(h).padStart(2,'0')}:00`);
  [supplyDemandChart, genMixChart, socChart, battFlowChart, pastComparisonChart, anomalyScoreChart].forEach(ch=> ch && ch.destroy());

  // Supply vs. Demand (with anomaly markers)
  const sdCtx = document.getElementById('supplyDemandChart').getContext('2d');
  const supplyLine = day.solar.map((v,i)=> v + day.wind[i] + Math.max(0, day.battFlow[i] < 0 ? -day.battFlow[i] : 0) + day.gas[i]);
  supplyDemandChart = new Chart(sdCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'Demand (kW)', data: day.demand, borderWidth:2, tension:.25,
          pointRadius: anom.score.map(s=> s>3 ? 5 : s>2.4 ? 3 : 0),
          pointHoverRadius: anom.score.map(s=> s>3 ? 7 : s>2.4 ? 5 : 3)
        },
        { label:'Supply (kW)', data: supplyLine, borderWidth:2, borderDash:[6,4], tension:.25 }
      ]
    },
    options:{
      animation:false, responsive:true,
      plugins:{
        legend:{ labels:{ color:'#e7eefb' } },
        tooltip:{ mode:'index', intersect:false,
          callbacks:{
            afterLabel: (ctx)=>{
              const i=ctx.dataIndex; const s=anom.score[i].toFixed(2);
              return `Anomaly Score: ${s}`;
            }
          }
        }
      },
      scales:{ x:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} },
               y:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} } }
    }
  });

  // Generation mix
  const gmCtx = document.getElementById('genMixChart').getContext('2d');
  genMixChart = new Chart(gmCtx, {
    type:'line',
    data:{ labels,
      datasets:[
        { label:'Solar', data: day.solar, fill:true, borderWidth:2, tension:.35 },
        { label:'Wind',  data: day.wind,  fill:true, borderWidth:2, tension:.35 },
        { label:'Gas',   data: day.gas,   fill:true, borderWidth:2, tension:.35 }
      ]},
    options:{ animation:false, responsive:true,
      plugins:{ legend:{ labels:{ color:'#e7eefb' }}},
      scales:{ x:{ stacked:true, ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} },
               y:{ stacked:true, ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} } }
    }
  });

  // SOC
  const socCtx = document.getElementById('socChart').getContext('2d');
  socChart = new Chart(socCtx, {
    type:'line',
    data:{ labels, datasets:[{ label:'SOC (%)', data:day.soc, borderWidth:2, tension:.25,
      pointRadius: anom.score.map(s=> s>3 ? 4 : 0) }]},
    options:{ animation:false, responsive:true,
      plugins:{ legend:{ labels:{ color:'#e7eefb' }}},
      scales:{ x:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} },
               y:{ min:0,max:100, ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} } }
    }
  });

  // Battery Flow
  const bfCtx = document.getElementById('battFlowChart').getContext('2d');
  battFlowChart = new Chart(bfCtx, {
    type:'bar',
    data:{ labels, datasets:[{ label:'Battery Flow (kW)', data: day.battFlow, borderWidth:1 }]},
    options:{ animation:false, responsive:true,
      plugins:{ legend:{ labels:{ color:'#e7eefb' }}},
      scales:{ x:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} },
               y:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} } }
    }
  });

  // Past comparison
  const dailyDemand = weekDays.map(d => d.demand.reduce((a,c)=>a+c,0));
  const dailyRenew  = weekDays.map(d => d.solar.reduce((a,c)=>a+c,0) + d.wind.reduce((a,c)=>a+c,0));
  const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const pcCtx = document.getElementById('pastComparisonChart').getContext('2d');
  pastComparisonChart = new Chart(pcCtx, {
    type:'bar',
    data:{ labels:dayLabels,
      datasets:[ { label:'Demand (kWh)', data:dailyDemand, borderWidth:1 },
                 { label:'Renewables (kWh)', data:dailyRenew, borderWidth:1 } ]},
    options:{ animation:false, responsive:true,
      plugins:{ legend:{ labels:{ color:'#e7eefb' }}},
      scales:{ x:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} },
               y:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} } }
    }
  });

  // Anomaly score
  const asCtx = document.getElementById('anomalyScoreChart').getContext('2d');
  anomalyScoreChart = new Chart(asCtx, {
    type:'line',
    data:{ labels, datasets:[{ label:'Anomaly Score', data: anom.score.map(v=> +v.toFixed(2)), borderWidth:2, tension:.25,
      pointRadius: anom.score.map(s=> s>3 ? 5 : s>2.4 ? 3 : 0) }]},
    options:{ animation:false, responsive:true,
      plugins:{ legend:{ labels:{ color:'#e7eefb' }},
        annotation: {} },
      scales:{ x:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} },
               y:{ ticks:{ color:'#96a0b5' }, grid:{ color:'rgba(255,255,255,.06)'} } }
    }
  });

  renderHeatStrip(anom.score);
}

// Heat strip rendering
function renderHeatStrip(score){
  const strip = document.getElementById('heatStrip'); strip.innerHTML='';
  const n = score.length;
  for(let i=0;i<n;i++){
    const s = score[i];
    const cell = document.createElement('div');
    cell.className='heat-cell';
    const x = (i/n)*100;
    const w = (1/n)*100 + 0.2;
    let c='rgba(55,214,122,.3)';
    if(s>3) c='rgba(255,93,93,.6)';
    else if(s>2.4) c='rgba(255,173,51,.5)';
    cell.style.left = x+'%'; cell.style.width = w+'%'; cell.style.background = `linear-gradient(180deg, ${c}, rgba(0,0,0,0))`;
    strip.appendChild(cell);
  }
}

// ===== Alerts & Anomaly List =====
function severityFromScore(s, sens){
  const hi = Math.max(2.0, sens);
  if(s > (hi+0.6)) return 'high';
  if(s > hi) return 'med';
  return 'low';
}
function explainForIndex(i, day, contrib){
  const reasons = [];
  if(contrib.demand>2.0) reasons.push('Demand spike');
  if(contrib.residual>2.0) reasons.push('Supply-demand mismatch');
  if(contrib.gas>2.0) reasons.push('Gas surge');
  if(contrib.solarDip>2.0) reasons.push('Solar underperformance');
  if(contrib.windDip>2.0) reasons.push('Wind lull');
  if(contrib.socDrop>0.5) reasons.push('SOC cliff');
  return reasons.length ? reasons.join(' • ') : 'Multi-factor deviation';
}
function renderAnomalyList(day, anom, sens=2.4){
  const ul = document.getElementById('anomList'); ul.innerHTML='';
  for(let i=0;i<anom.score.length;i++){
    const s = +anom.score[i].toFixed(2);
    if(s < sens) continue;
    const sev = severityFromScore(s, sens);
    const li = document.createElement('li');
    const pill = document.createElement('span'); pill.className = `pill ${sev}`; pill.textContent = sev.toUpperCase();
    const ts = String(i).padStart(2,'0')+':00';
    const msg = document.createElement('div'); msg.innerHTML = `<strong>${ts}</strong> — Score ${s} <br/><span style="color:#96a0b5">${explainForIndex(i, day, anom.contribs[i])}</span>`;
    li.append(pill, msg);
    ul.append(li);
  }
}

// ===== State & Controls =====
let currentDay=null, weekDays=null, refreshTimer=null, currentAnom=null;

function renderKPIs(day){
  const { renewablesShare, co2AvoidedKg, cost, peakDemand } = computeKPIs(day);
  document.getElementById('kpiRenewables').textContent = `${renewablesShare.toFixed(1)}%`;
  document.getElementById('kpiCO2').textContent = `${co2AvoidedKg.toFixed(0)} kg`;
  document.getElementById('kpiCost').textContent = `$${cost.toFixed(2)}`;
  document.getElementById('kpiPeak').textContent = `${peakDemand.toFixed(0)} kW`;
}

function renderAll(){
  renderKPIs(currentDay);
  currentAnom = computeAnomalyScore(currentDay);
  makeCharts(currentDay, weekDays, currentAnom);
  const sens = parseFloat(document.getElementById('sensSel').value);
  renderAnomalyList(currentDay, currentAnom, sens);
}

async function loadFromCsvOrSynthetic(scenario){
  const txtDay = await fetchCsvOrNull('data/today_telemetry.csv');
  const txtWeek = await fetchCsvOrNull('data/week_summary.csv');
  if(txtDay && txtWeek){
    const rows = parseCsv(txtDay);
    const day = {
      solar: rows.map(r => +r.solar_kW),
      wind: rows.map(r => +r.wind_kW),
      gas: rows.map(r => +r.gas_kW),
      demand: rows.map(r => +r.demand_kW),
      battFlow: rows.map(r => +r.battery_flow_kW),
      soc: rows.map(r => +r.soc_pct)
    };
    const weekRows = parseCsv(txtWeek);
    const baseline = generateDayData('baseline');
    weekDays = weekRows.map((wr)=>{
      const scaleD = baseline.demand.reduce((a,c)=>a+c,0)||1;
      const scaleR = (baseline.solar.reduce((a,c)=>a+c,0)+baseline.wind.reduce((a,c)=>a+c,0))||1;
      const d = JSON.parse(JSON.stringify(baseline));
      const fD=(+wr.demand_kWh)/scaleD, fR=(+wr.renewables_kWh)/scaleR;
      d.demand = d.demand.map(v=> Math.round(v*fD));
      d.solar  = d.solar.map(v=> Math.round(v*fR*0.6));
      d.wind   = d.wind.map(v=> Math.round(v*fR*0.4));
      d.gas    = d.demand.map((v,i)=> Math.max(0, v - (d.solar[i]+d.wind[i])));
      d.battFlow = d.battFlow.map(_=>0); d.soc = d.soc.map(_=>60);
      return d;
    });
    currentDay = day;
  } else {
    currentDay = generateDayData(scenario||'baseline');
    weekDays = generateWeekData();
  }
  renderAll();
}

// Controls
document.getElementById('applyBtn').addEventListener('click', ()=>{
  const scenario = document.getElementById('scenario').value;
  const refresh = +document.getElementById('refreshSel').value;
  if(refreshTimer){ clearInterval(refreshTimer); refreshTimer=null; }
  loadFromCsvOrSynthetic(scenario);
  if(refresh>0){
    refreshTimer = setInterval(()=> loadFromCsvOrSynthetic(scenario), refresh*1000);
  }
});
document.getElementById('recalcBtn').addEventListener('click', ()=>{
  factors.efGas=parseFloat(document.getElementById('efGas').value);
  factors.cSolar=parseFloat(document.getElementById('cSolar').value);
  factors.cWind=parseFloat(document.getElementById('cWind').value);
  factors.cGas=parseFloat(document.getElementById('cGas').value);
  renderKPIs(currentDay);
});
document.getElementById('sensSel').addEventListener('change', ()=> renderAnomalyList(currentDay, currentAnom, parseFloat(document.getElementById('sensSel').value)) );

// PNG buttons
document.querySelectorAll('[data-dl]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const key = btn.getAttribute('data-dl');
    const map = { supplyDemand:supplyDemandChart, genMix:genMixChart, soc:socChart, battFlow:battFlowChart, past:pastComparisonChart, anomScore:anomalyScoreChart };
    const ch = map[key]; if(ch) downloadPngFromChart(ch, `${key}.png`);
  });
});

// CSV export today
document.getElementById('dlCsvBtn').addEventListener('click', ()=>{
  const rows = HOURS.map(h=>({ hour: String(h).padStart(2,'0')+':00',
    solar_kW: currentDay.solar[h], wind_kW: currentDay.wind[h], gas_kW: currentDay.gas[h],
    demand_kW: currentDay.demand[h], battery_flow_kW: currentDay.battFlow[h], soc_pct: currentDay.soc[h] }));
  download('today_export.csv', toCsv(rows));
});

// Init
loadFromCsvOrSynthetic('baseline');
console.log("v3 (clean): modal removed. AI anomalies intact.");
