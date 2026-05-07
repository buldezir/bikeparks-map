import './style.css'
import 'leaflet/dist/leaflet.css'

import L from 'leaflet'
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson'

type BikeParkProps = {
  id: string
  name: string
  address: string
  country: string
  /** Official / resort site (https). */
  website?: string
}

type BikeParkFeature = Feature<Point, BikeParkProps>

const FORECAST_MIN_ZOOM = 8
const CACHE_TTL_MS = 60 * 60 * 1000
const FORECAST_DAYS = 14
const FORECAST_LS_PREFIX = 'bikepark-weather:v1:forecast:'
/** Fixed default view — the map does not auto-fit all parks after load. */
const INITIAL_MAP_CENTER: L.LatLngExpression = [48.4, 10.88]
const INITIAL_MAP_ZOOM = 7

type OpenMeteoDaily = {
  time: string[]
  weather_code: number[]
  temperature_2m_max: number[]
  temperature_2m_min: number[]
  precipitation_probability_max?: number[]
}

type OpenMeteoResponse = {
  daily?: OpenMeteoDaily
}

const forecastCache = new Map<string, { at: number; data: OpenMeteoResponse }>()

function forecastLocalStorageKey(cacheKey: string): string {
  return `${FORECAST_LS_PREFIX}${cacheKey}`
}

function readForecastFromLocalStorage(cacheKey: string): { at: number; data: OpenMeteoResponse } | null {
  try {
    const raw = localStorage.getItem(forecastLocalStorageKey(cacheKey))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const rec = parsed as { at?: unknown; data?: unknown }
    if (typeof rec.at !== 'number' || rec.data === null || typeof rec.data !== 'object') return null
    if (Date.now() - rec.at >= CACHE_TTL_MS) {
      localStorage.removeItem(forecastLocalStorageKey(cacheKey))
      return null
    }
    return { at: rec.at, data: rec.data as OpenMeteoResponse }
  } catch {
    return null
  }
}

function writeForecastToLocalStorage(cacheKey: string, entry: { at: number; data: OpenMeteoResponse }): void {
  try {
    localStorage.setItem(forecastLocalStorageKey(cacheKey), JSON.stringify(entry))
  } catch {
    // Quota, private mode, or disabled storage — in-memory cache still works.
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function describeWeatherCode(code: number): string {
  if (code === 0) return 'Clear sky'
  if (code <= 3) return 'Mainly clear / partly cloudy'
  if (code <= 48) return 'Fog / depositing rime fog'
  if (code <= 57) return 'Drizzle'
  if (code <= 67) return 'Rain'
  if (code <= 77) return 'Snow'
  if (code <= 82) return 'Rain showers'
  if (code <= 86) return 'Snow showers'
  if (code <= 99) return 'Thunderstorm'
  return 'Mixed conditions'
}

/** Open-Meteo WMO weathercode → compact icon (emoji) for map pills */
function weatherCodeIcon(code: number): string {
  if (code === 0) return '☀️'
  if (code <= 3) return '⛅'
  if (code <= 48) return '🌫️'
  if (code <= 57) return '🌦️'
  if (code <= 67) return '🌧️'
  if (code <= 77) return '🌨️'
  if (code <= 82) return '🌧️'
  if (code <= 86) return '❄️'
  if (code <= 99) return '⛈️'
  return '🌤️'
}

function formatUltraShortForecast(data: OpenMeteoResponse): string | null {
  const daily = data.daily
  if (!daily?.time?.length) return null
  const code = daily.weather_code[0]
  const tMax = daily.temperature_2m_max[0]
  const tMin = daily.temperature_2m_min[0]
  const icon = weatherCodeIcon(code)
  const temps =
    Math.abs(tMax - tMin) < 2 ? `${Math.round(tMax)}°` : `${Math.round(tMin)}–${Math.round(tMax)}°`
  return `${icon}\u00A0${temps}`
}

function buildPillMarkup(name: string, ultraShort: string | null): string {
  const fc = ultraShort
    ? `<div class="park-pill__forecast">${ultraShort}</div>`
    : ''
  return `<div class="park-pill">${fc}<div class="park-pill__name">${escapeHtml(name)}</div></div>`
}

function buildMarkerIconHtml(name: string, ultraShort: string | null): string {
  return `<div class="park-pill-hitbox"><div class="park-pill-root">${buildPillMarkup(name, ultraShort)}</div></div>`
}

function formatDayLabel(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

async function fetchForecast(lat: number, lon: number, cacheKey: string): Promise<OpenMeteoResponse> {
  const hit = forecastCache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.data
  }

  const stored = readForecastFromLocalStorage(cacheKey)
  if (stored) {
    forecastCache.set(cacheKey, stored)
    return stored.data
  }

  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(lat))
  url.searchParams.set('longitude', String(lon))
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  )
  url.searchParams.set('forecast_days', String(FORECAST_DAYS))
  url.searchParams.set('timezone', 'auto')

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`Weather request failed (${res.status})`)
  }

  const data = (await res.json()) as OpenMeteoResponse
  const entry = { at: Date.now(), data }
  forecastCache.set(cacheKey, entry)
  writeForecastToLocalStorage(cacheKey, entry)
  return data
}

function renderForecastHtml(data: OpenMeteoResponse): string {
  const daily = data.daily
  if (!daily?.time?.length) {
    return '<p class="muted">No forecast data available.</p>'
  }

  const rows: string[] = []
  const n = Math.min(daily.time.length, FORECAST_DAYS)
  for (let i = 0; i < n; i++) {
    const code = daily.weather_code[i]
    const tMax = daily.temperature_2m_max[i]
    const tMin = daily.temperature_2m_min[i]
    const precip = daily.precipitation_probability_max?.[i]
    const summary = describeWeatherCode(code)
    const precipBit =
      precip !== undefined && !Number.isNaN(precip) ? ` · rain chance ${Math.round(precip)}%` : ''
    rows.push(
      `<li><strong>${escapeHtml(formatDayLabel(daily.time[i]))}</strong> ${weatherCodeIcon(code)} ${escapeHtml(summary)} · <strong>${Math.round(tMin)}–${Math.round(tMax)}°C</strong>${escapeHtml(precipBit)}</li>`,
    )
  }

  return `<div class="forecast"><ul>${rows.join('')}</ul></div>`
}

function pointCoordinates(g: Geometry): [number, number] | null {
  if (g.type !== 'Point') return null
  const [lon, lat] = g.coordinates
  return [lon, lat]
}

/** Opens Google Maps directions with this point as destination (user chooses start). */
function googleMapsRouteUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({ api: '1', destination: `${lat},${lon}` })
  return `https://www.google.com/maps/dir/?${q}`
}

function isAllowedWebsiteUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

function buildPopupTitleHtml(props: BikeParkProps): string {
  const title = escapeHtml(props.name)
  const raw = props.website?.trim()
  if (raw && isAllowedWebsiteUrl(raw)) {
    const href = escapeHtml(raw)
    return `<h2 class="park-popup__title"><a class="park-popup__title-link" href="${href}" target="_blank" rel="noopener noreferrer">${title}</a></h2>`
  }
  return `<h2 class="park-popup__title">${title}</h2>`
}

function buildPopupShell(props: BikeParkProps, coords: [number, number]): string {
  const [lon, lat] = coords
  const routeUrl = googleMapsRouteUrl(lat, lon)
  return `
<div class="park-popup">
  ${buildPopupTitleHtml(props)}
  <p class="address">${escapeHtml(props.address)}</p>
  <p class="route-link"><a href="${escapeHtml(routeUrl)}" target="_blank" rel="noopener noreferrer">Plan route in Google Maps</a></p>
  <div class="forecast-slot"></div>
</div>`
}

const map = L.map('map', {
  zoomControl: true,
  worldCopyJump: true,
  /** Southern Germany (Augsburg area). */
  center: INITIAL_MAP_CENTER,
  zoom: INITIAL_MAP_ZOOM,
})

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Weather: <a href="https://open-meteo.com/">Open-Meteo</a>',
  maxZoom: 19,
}).addTo(map)

const zoomReadout = document.querySelector<HTMLElement>('#zoom-readout')
const forecastNote = document.querySelector<HTMLElement>('#forecast-note')

function updateChrome(): void {
  const z = map.getZoom()
  if (zoomReadout) {
    zoomReadout.textContent = `Zoom ${z.toFixed(1)}`
  }
  if (forecastNote) {
    forecastNote.textContent =
      z >= FORECAST_MIN_ZOOM
        ? 'Map labels show today’s quick icon forecast; tap a marker for full details anytime.'
        : `Zoom to ${FORECAST_MIN_ZOOM}+ for icon forecasts on map labels. Pop-up forecast loads at any zoom.`
  }
}

map.on('zoom zoomend', updateChrome)
updateChrome()

type PillMarkerEntry = {
  marker: L.Marker
  props: BikeParkProps
  coords: [number, number]
}

const pillMarkers: PillMarkerEntry[] = []
let pillRefreshGen = 0

let openPopup: {
  marker: L.Marker
  feature: BikeParkFeature
  container: HTMLElement
  coords: [number, number]
  seq: number
} | null = null

async function refreshAllPillLabels(): Promise<void> {
  const gen = ++pillRefreshGen
  const z = map.getZoom()

  if (z < FORECAST_MIN_ZOOM) {
    for (const pm of pillMarkers) {
      const root = pm.marker.getElement()?.querySelector<HTMLElement>('.park-pill-root')
      if (root) root.innerHTML = buildPillMarkup(pm.props.name, null)
    }
    return
  }

  const rows = await Promise.all(
    pillMarkers.map(async (pm) => {
      try {
        const data = await fetchForecast(pm.coords[1], pm.coords[0], pm.props.id)
        const short = formatUltraShortForecast(data)
        return { pm, short }
      } catch {
        return { pm, short: null as string | null }
      }
    }),
  )

  if (gen !== pillRefreshGen) return

  for (const { pm, short } of rows) {
    const root = pm.marker.getElement()?.querySelector<HTMLElement>('.park-pill-root')
    if (root) root.innerHTML = buildPillMarkup(pm.props.name, short ?? '—')
  }
}

async function fillForecastSlot(
  marker: L.Marker,
  container: HTMLElement,
  feature: BikeParkProps,
  coords: [number, number],
  seq: number,
): Promise<void> {
  const slot = container.querySelector<HTMLElement>('.forecast-slot')
  if (!slot) return

  slot.innerHTML = `<p class="loading">Loading forecast…</p>`
  try {
    const data = await fetchForecast(coords[1], coords[0], feature.id)
    if (!openPopup || openPopup.seq !== seq) return
    slot.innerHTML = renderForecastHtml(data)
  } catch {
    if (!openPopup || openPopup.seq !== seq) return
    slot.innerHTML = `<p class="error">Could not load forecast. Try again in a moment.</p>`
  }
  // Leaflet measures popup size on open only; widen layout after async content replaces loading state.
  requestAnimationFrame(() => {
    marker.getPopup()?.update()
  })
}

async function loadBikeParks(): Promise<void> {
  const res = await fetch('/bikeparks.geojson')
  if (!res.ok) {
    throw new Error(`Could not load bike parks (${res.status})`)
  }

  const collection = (await res.json()) as FeatureCollection<Point, BikeParkProps>
  L.geoJSON(collection as GeoJSON.GeoJsonObject, {
    pointToLayer(feature, latlng) {
      const bf = feature as BikeParkFeature
      const props = bf.properties
      const icon = L.divIcon({
        className: 'park-pill-marker',
        html: buildMarkerIconHtml(props.name, null),
        iconSize: [260, 96],
        iconAnchor: [130, 96],
      })
      return L.marker(latlng, { icon })
    },
    onEachFeature(feature, lyr) {
      const bf = feature as BikeParkFeature
      const props = bf.properties
      const coords = pointCoordinates(bf.geometry)
      if (!coords) return

      const marker = lyr as L.Marker
      pillMarkers.push({ marker, props, coords })

      const container = document.createElement('div')
      container.innerHTML = buildPopupShell(props, coords)
      marker.bindPopup(container, {
        maxWidth: 600,
        keepInView: true,
        autoPanPadding: [20, 20],
      })

      marker.on('popupopen', () => {
        const seq = Date.now()
        openPopup = { marker, feature: bf, container, coords, seq }
        void fillForecastSlot(marker, container, props, coords, seq)
      })

      marker.on('popupclose', () => {
        openPopup = null
      })
    },
  }).addTo(map)

  void refreshAllPillLabels()
}

map.on('zoomend', () => {
  void refreshAllPillLabels()
})

void loadBikeParks().catch(() => {
  const banner = document.createElement('div')
  banner.textContent = 'Could not load bike parks data.'
  banner.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2000;background:#fef3f2;color:#b42318;padding:8px 12px;border-radius:8px;font:14px system-ui'
  document.body.appendChild(banner)
})
