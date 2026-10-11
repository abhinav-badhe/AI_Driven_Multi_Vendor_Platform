import React, { useEffect, useRef, useState } from 'react';
import {
  MapPin,
  Truck,
  ExternalLink,
  Compass
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';

// Dynamically import Leaflet only in browser
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface DeliveryAddressCoords {
  recipientName?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  formattedAddress?: string | null;
}

export interface RouteMilestone {
  step: string;
  location: string;
  lat: number;
  lng: number;
  status: 'COMPLETED' | 'IN_TRANSIT' | 'PENDING';
  timestamp?: string;
  details?: string;
}

interface DeliveryRouteMapProps {
  shipmentId?: string | undefined;
  trackingNumber?: string | undefined;
  carrier?: string | undefined;
  status: string;
  deliveryAddress?: DeliveryAddressCoords | null | undefined;
  originHub?: {
    name: string;
    city: string;
    lat: number;
    lng: number;
  } | undefined;
  onAdvanceStatus?: (() => void) | undefined;
  isUpdating?: boolean | undefined;
}

// Known coordinates mapping for reliable geocoding fallback
const KNOWN_GEO_COORDINATES: Record<string, { lat: number; lng: number }> = {
  pune: { lat: 18.5204, lng: 73.8567 },
  alandi: { lat: 18.6755, lng: 73.8967 },
  mumbai: { lat: 19.0760, lng: 72.8777 },
  delhi: { lat: 28.6139, lng: 77.2090 },
  bangalore: { lat: 12.9716, lng: 77.5946 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
  hyderabad: { lat: 17.3850, lng: 78.4867 },
  chennai: { lat: 13.0827, lng: 80.2707 },
  kolkata: { lat: 22.5726, lng: 88.3639 },
  'san francisco': { lat: 37.7749, lng: -122.4194 },
  'new york': { lat: 40.7128, lng: -74.0060 },
  austin: { lat: 30.2672, lng: -97.7431 },
};

function resolveCoordinates(address?: DeliveryAddressCoords | null): { lat: number; lng: number } {
  if (address?.latitude && address?.longitude && !isNaN(address.latitude) && !isNaN(address.longitude)) {
    return { lat: Number(address.latitude), lng: Number(address.longitude) };
  }

  // Lookup by city or address keywords
  const city = (address?.city || '').toLowerCase().trim();
  if (KNOWN_GEO_COORDINATES[city]) {
    return KNOWN_GEO_COORDINATES[city];
  }

  const raw = `${address?.addressLine1 || ''} ${address?.city || ''}`.toLowerCase();
  for (const [key, coords] of Object.entries(KNOWN_GEO_COORDINATES)) {
    if (raw.includes(key)) {
      return coords;
    }
  }

  // Default to Pune Hub region if not found
  return { lat: 18.6755, lng: 73.8967 };
}

// Calculate Haversine distance in KM
function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Radius of the Earth in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export const DeliveryRouteMap: React.FC<DeliveryRouteMapProps> = ({
  trackingNumber,
  carrier = 'BlueDart Express',
  status,
  deliveryAddress,
  originHub = {
    name: 'Merchant Central Fulfillment Hub (FC-01)',
    city: 'Hinjawadi, Pune',
    lat: 18.5913,
    lng: 73.7389,
  },
  onAdvanceStatus,
  isUpdating = false,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<L.Map | null>(null);
  const [mapMode, setMapMode] = useState<'interactive' | 'google_satellite'>('interactive');

  const destCoords = resolveCoordinates(deliveryAddress);
  const originCoords = { lat: originHub.lat, lng: originHub.lng };

  const distanceKm = calculateDistanceKm(
    originCoords.lat,
    originCoords.lng,
    destCoords.lat,
    destCoords.lng,
  );
  const estimatedMins = Math.max(15, Math.round(distanceKm * 2.2));

  // Determine progress along route based on fulfillment status
  const progressPercent = (() => {
    switch (status) {
      case 'PENDING':
        return 0.05;
      case 'READY_TO_SHIP':
        return 0.15;
      case 'SHIPPED':
        return 0.35;
      case 'IN_TRANSIT':
        return 0.65;
      case 'OUT_FOR_DELIVERY':
        return 0.88;
      case 'DELIVERED':
        return 1.0;
      default:
        return 0.5;
    }
  })();

  // Vehicle current position interpolated along route
  const vehicleLat = originCoords.lat + (destCoords.lat - originCoords.lat) * progressPercent;
  const vehicleLng = originCoords.lng + (destCoords.lng - originCoords.lng) * progressPercent;

  // Build route waypoints
  const waypoints: RouteMilestone[] = [
    {
      step: '1. Origin Dispatch Hub',
      location: originHub.name,
      lat: originCoords.lat,
      lng: originCoords.lng,
      status: 'COMPLETED',
      timestamp: '09:30 AM',
      details: 'Package sorted, weighed, and barcoded.',
    },
    {
      step: '2. Regional Logistics Facility',
      location: `${originHub.city} Gateway Sorting Node`,
      lat: originCoords.lat + (destCoords.lat - originCoords.lat) * 0.35,
      lng: originCoords.lng + (destCoords.lng - originCoords.lng) * 0.35,
      status: progressPercent >= 0.35 ? 'COMPLETED' : 'PENDING',
      timestamp: progressPercent >= 0.35 ? '11:15 AM' : 'Pending dispatch',
      details: 'Line-haul container scanned and sealed.',
    },
    {
      step: '3. Destination Last-Mile Center',
      location: `${deliveryAddress?.city || 'Local'} Distribution Hub`,
      lat: originCoords.lat + (destCoords.lat - originCoords.lat) * 0.7,
      lng: originCoords.lng + (destCoords.lng - originCoords.lng) * 0.7,
      status: progressPercent >= 0.65 ? 'COMPLETED' : progressPercent >= 0.35 ? 'IN_TRANSIT' : 'PENDING',
      timestamp: progressPercent >= 0.65 ? '01:45 PM' : 'Scheduled',
      details: 'Assigned to delivery route courier.',
    },
    {
      step: '4. Customer Doorstep Delivery',
      location: deliveryAddress?.formattedAddress || `${deliveryAddress?.addressLine1 || 'Customer Address'}, ${deliveryAddress?.city || ''}`,
      lat: destCoords.lat,
      lng: destCoords.lng,
      status: status === 'DELIVERED' ? 'COMPLETED' : progressPercent >= 0.85 ? 'IN_TRANSIT' : 'PENDING',
      timestamp: status === 'DELIVERED' ? 'Delivered' : `Estimated in ${estimatedMins} mins`,
      details: `Delivery for ${deliveryAddress?.recipientName || 'Customer'}.`,
    },
  ];

  // Initialize or re-render Leaflet Map
  useEffect(() => {
    if (mapMode !== 'interactive' || !mapContainerRef.current) return;

    if (leafletMapRef.current) {
      leafletMapRef.current.remove();
      leafletMapRef.current = null;
    }

    const map = L.map(mapContainerRef.current, {
      center: [vehicleLat, vehicleLng],
      zoom: 12,
      scrollWheelZoom: false,
    });

    leafletMapRef.current = map;

    // OpenStreetMap Cartography Tile Layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    // Custom Origin Warehouse Icon
    const originIcon = L.divIcon({
      className: 'custom-map-icon',
      html: `
        <div style="background-color: #0f766e; color: white; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.3); border: 2px solid white;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3l3-2 3 2"/></svg>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });

    // Custom Destination Pin Icon
    const destIcon = L.divIcon({
      className: 'custom-map-icon',
      html: `
        <div style="background-color: #e11d48; color: white; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.3); border: 2px solid white;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 34],
    });

    // Custom Delivery Courier Truck Icon
    const vehicleIcon = L.divIcon({
      className: 'custom-map-icon',
      html: `
        <div style="background-color: #2563eb; color: white; width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 6px rgba(37,99,235,0.25); border: 2px solid white; animation: pulse 2s infinite;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });

    // Place Markers
    L.marker([originCoords.lat, originCoords.lng], { icon: originIcon })
      .addTo(map)
      .bindPopup(`<b>Origin Hub:</b><br/>${originHub.name}<br/>Lat: ${originCoords.lat.toFixed(4)}, Lng: ${originCoords.lng.toFixed(4)}`);

    L.marker([destCoords.lat, destCoords.lng], { icon: destIcon })
      .addTo(map)
      .bindPopup(`<b>Customer Destination:</b><br/>${deliveryAddress?.recipientName || 'Customer'}<br/>${deliveryAddress?.addressLine1 || ''}, ${deliveryAddress?.city || ''}<br/>Lat: ${destCoords.lat.toFixed(4)}, Lng: ${destCoords.lng.toFixed(4)}`);

    if (status !== 'DELIVERED') {
      L.marker([vehicleLat, vehicleLng], { icon: vehicleIcon })
        .addTo(map)
        .bindPopup(`<b>Live Courier Position:</b><br/>${carrier} Fleet<br/>Status: ${status}<br/>Distance to destination: ${(distanceKm * (1 - progressPercent)).toFixed(1)} km`);
    }

    // Draw Curving Route Polyline between origin and destination
    const routePoints: L.LatLngExpression[] = [
      [originCoords.lat, originCoords.lng],
      [originCoords.lat + (destCoords.lat - originCoords.lat) * 0.35 + 0.008, originCoords.lng + (destCoords.lng - originCoords.lng) * 0.35 - 0.005],
      [originCoords.lat + (destCoords.lat - originCoords.lat) * 0.7 - 0.005, originCoords.lng + (destCoords.lng - originCoords.lng) * 0.7 + 0.008],
      [destCoords.lat, destCoords.lng],
    ];

    L.polyline(routePoints, {
      color: '#0f766e',
      weight: 5,
      opacity: 0.8,
      dashArray: status === 'DELIVERED' ? undefined : '8, 8',
    }).addTo(map);

    // Fit bounds to show both origin and destination with padding
    const bounds = L.latLngBounds([
      [originCoords.lat, originCoords.lng],
      [destCoords.lat, destCoords.lng],
    ]);
    map.fitBounds(bounds, { padding: [50, 50] });

    return () => {
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, [mapMode, destCoords.lat, destCoords.lng, status]);

  // Google Maps Universal Driving Directions URL
  const googleMapsDirectionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${originCoords.lat},${originCoords.lng}&destination=${destCoords.lat},${destCoords.lng}&travelmode=driving`;
  const googleMapsEmbedUrl = `https://maps.google.com/maps?q=${destCoords.lat},${destCoords.lng}&t=m&z=14&ie=UTF8&iwloc=&output=embed`;

  return (
    <Card className="overflow-hidden border border-border shadow-sm">
      <CardHeader className="border-b border-border bg-muted/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Compass className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-semibold">Live Fulfillment Route & Delivery Telemetry</CardTitle>
                <Badge variant={status === 'DELIVERED' ? 'success' : 'default'} className="text-[11px]">
                  {status.replace(/_/g, ' ')}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Origin Hub → Customer Delivery Pinpoint with Coordinates & Real-Time Tracking
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-border bg-background p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMapMode('interactive')}
                className={`rounded px-2.5 py-1 font-medium transition ${
                  mapMode === 'interactive' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Interactive Map
              </button>
              <button
                type="button"
                onClick={() => setMapMode('google_satellite')}
                className={`rounded px-2.5 py-1 font-medium transition ${
                  mapMode === 'google_satellite' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Google Maps Embed
              </button>
            </div>

            <a
              href={googleMapsDirectionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <span>Open in Google Maps</span>
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Main Map View Area */}
          <div className="relative min-h-[420px] bg-muted lg:col-span-8">
            {mapMode === 'interactive' ? (
              <div ref={mapContainerRef} className="h-full min-h-[420px] w-full" />
            ) : (
              <iframe
                title="Google Maps Embed View"
                src={googleMapsEmbedUrl}
                className="h-full min-h-[420px] w-full border-0"
                loading="lazy"
              />
            )}

            {/* Float Coordinates & Route Stats HUD */}
            <div className="absolute bottom-3 left-3 right-3 z-[1000] flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 bg-background/95 p-2.5 backdrop-blur shadow-md sm:left-4 sm:right-auto sm:max-w-lg">
              <div className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Truck className="size-4" />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <span>{distanceKm} km transit distance</span>
                    <span className="text-muted-foreground">•</span>
                    <span className="text-emerald-600 dark:text-emerald-400">~{estimatedMins} mins travel</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Carrier: <span className="font-medium text-foreground">{carrier}</span> (Tracking: {trackingNumber || 'Pending'})
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-[11px] font-mono">
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                  LAT {destCoords.lat.toFixed(4)}°
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                  LNG {destCoords.lng.toFixed(4)}°
                </span>
              </div>
            </div>
          </div>

          {/* Right Information & Route Steps Panel */}
          <div className="flex flex-col border-t border-border bg-card p-4 lg:col-span-4 lg:border-t-0 lg:border-l">
            {/* Customer Delivery Target Card */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-full bg-rose-500/10 text-rose-600">
                    <MapPin className="size-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      {deliveryAddress?.recipientName || 'Customer Recipient'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {deliveryAddress?.phone || '+91 77740 94369'}
                    </p>
                  </div>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  Customer Pin
                </Badge>
              </div>

              <div className="mt-2 text-xs text-muted-foreground">
                <p className="line-clamp-2">
                  {deliveryAddress?.formattedAddress ||
                    `${deliveryAddress?.addressLine1 || 'Alandi'}, ${deliveryAddress?.city || 'Pune'}, ${deliveryAddress?.state || 'Maharashtra'} ${deliveryAddress?.postalCode || '412105'}`}
                </p>
                <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-primary">
                  <span>📍 {destCoords.lat.toFixed(4)}° N, {destCoords.lng.toFixed(4)}° E</span>
                </div>
              </div>
            </div>

            {/* Delivery Waypoint Timeline */}
            <div className="mt-4 flex-1">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Fulfillment Route Milestones
              </h3>
              <div className="mt-2.5 space-y-3">
                {waypoints.map((wp, index) => (
                  <div key={index} className="flex items-start gap-2.5 text-xs">
                    <div className="mt-0.5 flex flex-col items-center">
                      <div
                        className={`size-2.5 rounded-full ${
                          wp.status === 'COMPLETED'
                            ? 'bg-emerald-500 ring-2 ring-emerald-500/30'
                            : wp.status === 'IN_TRANSIT'
                              ? 'bg-blue-500 ring-2 ring-blue-500/30 animate-pulse'
                              : 'bg-muted-foreground/30'
                        }`}
                      />
                      {index < waypoints.length - 1 && (
                        <div
                          className={`h-7 w-0.5 ${
                            wp.status === 'COMPLETED' ? 'bg-emerald-500/60' : 'bg-border'
                          }`}
                        />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground">{wp.step}</span>
                        <span className="text-[10px] text-muted-foreground">{wp.timestamp}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{wp.location}</p>
                      <p className="text-[10px] text-muted-foreground/80">{wp.details}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Advance Status Controls */}
            {onAdvanceStatus && (
              <div className="mt-4 pt-3 border-t border-border">
                <Button
                  className="w-full justify-center gap-2"
                  size="sm"
                  onClick={onAdvanceStatus}
                  disabled={isUpdating || status === 'DELIVERED'}
                >
                  <Truck className="size-4" />
                  <span>
                    {isUpdating
                      ? 'Updating delivery status…'
                      : status === 'DELIVERED'
                        ? 'Package Successfully Delivered'
                        : `Advance Delivery: ${status.replace(/_/g, ' ')}`}
                  </span>
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
