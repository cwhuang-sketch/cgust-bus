// api/schedule.js
// 公開 API：讀取所有班表資料（前台使用）
// GET /api/schedule
// 回傳：stops, school_routes（含 trips+stops）, bus_routes（含 directions）

function setCORS(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

export default async function handler(req, res) {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return res.status(503).json({ error: 'Database not configured' });

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json'
  };

  try {
    // 並行查詢所有資料
    const [stopsRes, routesRes, tripsRes, tripStopsRes, busRoutesRes, busDirectionsRes] = await Promise.all([
      fetch(`${url}/rest/v1/stops?active=eq.true&order=sort_order.asc`, { headers }),
      fetch(`${url}/rest/v1/school_routes?order=sort_order.asc`, { headers }),
      fetch(`${url}/rest/v1/school_trips?order=sort_order.asc`, { headers }),
      fetch(`${url}/rest/v1/trip_stops?order=seq.asc`, { headers }),
      fetch(`${url}/rest/v1/bus_routes?active=eq.true&order=sort_order.asc`, { headers }),
      fetch(`${url}/rest/v1/bus_directions?order=seq.asc`, { headers }),
    ]);

    // 檢查所有請求是否成功
    const responses = [stopsRes, routesRes, tripsRes, tripStopsRes, busRoutesRes, busDirectionsRes];
    for (const r of responses) {
      if (!r.ok) {
        console.error('[schedule] DB error:', r.status, await r.text());
        return res.status(502).json({ error: 'Database query failed' });
      }
    }

    const [stops, routes, trips, tripStops, busRoutes, busDirections] = await Promise.all(
      responses.map(r => r.json())
    );

    // 組合校內班次資料
    const tripsWithStops = trips.map(trip => ({
      ...trip,
      stops: tripStops
        .filter(ts => ts.trip_id === trip.id)
        .map(ts => ({ id: ts.stop_id, t: ts.arrive_time }))
    }));

    const schoolRoutesWithTrips = routes.map(route => ({
      ...route,
      trips: tripsWithStops.filter(t => t.route_id === route.id)
    }));

    // 組合公車路線資料
    const busRoutesWithDirs = busRoutes.map(route => ({
      ...route,
      directions: (() => {
        const dirs = busDirections.filter(d => d.route_id === route.id);
        // 依 direction 分組
        const grouped = {};
        dirs.forEach(d => {
          if (!grouped[d.direction]) {
            grouped[d.direction] = {
              dir: d.direction,
              desc_zh: d.desc_zh,
              desc_en: d.desc_en,
              stops: []
            };
          }
          grouped[d.direction].stops.push({
            id: d.stop_id,
            tdx_stop_name: d.tdx_stop_name
          });
        });
        return Object.values(grouped).sort((a, b) => a.dir - b.dir);
      })()
    }));

    // 快取 30 秒
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    return res.status(200).json({
      stops,
      school_routes: schoolRoutesWithTrips,
      bus_routes: busRoutesWithDirs,
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    console.error('[schedule] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
