import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Search, AlertCircle } from 'lucide-react';
import { Input, Label } from '../../../components/ui/input';

export interface PlaceSelectionResult {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  googlePlaceId: string | null;
  formattedAddress: string | null;
}

interface GoogleAddressPickerProps {
  initialLat?: number | null;
  initialLng?: number | null;
  onPlaceSelect: (result: PlaceSelectionResult) => void;
  onCoordinatesChange: (lat: number | null, lng: number | null) => void;
  className?: string;
}

declare global {
  interface Window {
    google?: any;
    __googleMapsLoadingPromise?: Promise<void>;
  }
}

function loadGoogleMapsScript(apiKey: string): Promise<void> {
  if (window.google?.maps?.places) {
    return Promise.resolve();
  }
  if (window.__googleMapsLoadingPromise) {
    return window.__googleMapsLoadingPromise;
  }

  window.__googleMapsLoadingPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector('script[data-google-maps="true"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve());
      existingScript.addEventListener('error', (err) => reject(err));
      return;
    }

    const script = document.createElement('script');
    script.setAttribute('data-google-maps', 'true');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });

  return window.__googleMapsLoadingPromise;
}

export const GoogleAddressPicker: React.FC<GoogleAddressPickerProps> = ({
  initialLat,
  initialLng,
  onPlaceSelect,
  onCoordinatesChange,
  className = '',
}) => {
  const apiKey = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_GOOGLE_MAPS_API_KEY || '';
  const [isMapsLoaded, setIsMapsLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const autocompleteInputRef = useRef<HTMLInputElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markerInstanceRef = useRef<any>(null);

  const [currentLat, setCurrentLat] = useState<number | null>(initialLat ?? null);
  const [currentLng, setCurrentLng] = useState<number | null>(initialLng ?? null);
  const [searchQuery, setSearchQuery] = useState('');

  // Try loading Google Maps if API key is provided
  useEffect(() => {
    if (!apiKey) {
      return;
    }

    loadGoogleMapsScript(apiKey)
      .then(() => {
        setIsMapsLoaded(true);
      })
      .catch(() => {
        setMapError('Failed to load Google Maps SDK. Manual address entry remains available.');
      });
  }, [apiKey]);

  // Initialize Places Autocomplete and Interactive Map
  useEffect(() => {
    if (!isMapsLoaded || !window.google?.maps) return;

    // 1. Initialize Autocomplete
    if (autocompleteInputRef.current) {
      const autocomplete = new window.google.maps.places.Autocomplete(
        autocompleteInputRef.current,
        {
          fields: ['address_components', 'geometry', 'place_id', 'formatted_address'],
          types: ['geocode', 'establishment'],
        },
      );

      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (!place || !place.address_components) return;

        let streetNumber = '';
        let route = '';
        let city = '';
        let state = '';
        let postalCode = '';
        let country = 'US';

        for (const component of place.address_components) {
          const types: string[] = component.types;
          if (types.includes('street_number')) {
            streetNumber = component.long_name;
          } else if (types.includes('route')) {
            route = component.long_name;
          } else if (types.includes('locality')) {
            city = component.long_name;
          } else if (types.includes('postal_town') && !city) {
            city = component.long_name;
          } else if (types.includes('sublocality_level_1') && !city) {
            city = component.long_name;
          } else if (types.includes('administrative_area_level_1')) {
            state = component.short_name || component.long_name;
          } else if (types.includes('postal_code')) {
            postalCode = component.long_name;
          } else if (types.includes('country')) {
            country = component.short_name || component.long_name;
          }
        }

        const addressLine1 = [streetNumber, route].filter(Boolean).join(' ') || place.name || '';
        const lat = place.geometry?.location?.lat() ?? null;
        const lng = place.geometry?.location?.lng() ?? null;

        if (lat !== null && lng !== null) {
          setCurrentLat(lat);
          setCurrentLng(lng);
          onCoordinatesChange(lat, lng);

          // Update Map view and Marker position
          if (mapInstanceRef.current) {
            const pos = new window.google.maps.LatLng(lat, lng);
            mapInstanceRef.current.setCenter(pos);
            mapInstanceRef.current.setZoom(16);
            if (markerInstanceRef.current) {
              markerInstanceRef.current.setPosition(pos);
            }
          }
        }

        onPlaceSelect({
          addressLine1,
          city,
          state,
          postalCode,
          country,
          latitude: lat,
          longitude: lng,
          googlePlaceId: place.place_id || null,
          formattedAddress: place.formatted_address || null,
        });

        if (place.formatted_address) {
          setSearchQuery(place.formatted_address);
        }
      });
    }

    // 2. Initialize Interactive Map
    if (mapContainerRef.current) {
      const defaultCenter = {
        lat: currentLat ?? 37.7749,
        lng: currentLng ?? -122.4194,
      };

      const map = new window.google.maps.Map(mapContainerRef.current, {
        center: defaultCenter,
        zoom: currentLat ? 15 : 11,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
      mapInstanceRef.current = map;

      const marker = new window.google.maps.Marker({
        position: defaultCenter,
        map,
        draggable: true,
        title: 'Drag marker to refine exact delivery location',
        animation: window.google.maps.Animation.DROP,
      });
      markerInstanceRef.current = marker;

      // Allow dragging marker to refine location
      marker.addListener('dragend', () => {
        const newPos = marker.getPosition();
        if (newPos) {
          const lat = newPos.lat();
          const lng = newPos.lng();
          setCurrentLat(lat);
          setCurrentLng(lng);
          onCoordinatesChange(lat, lng);
        }
      });

      // Allow clicking on map to move marker
      map.addListener('click', (event: any) => {
        if (event.latLng) {
          marker.setPosition(event.latLng);
          const lat = event.latLng.lat();
          const lng = event.latLng.lng();
          setCurrentLat(lat);
          setCurrentLng(lng);
          onCoordinatesChange(lat, lng);
        }
      });
    }
  }, [isMapsLoaded]);

  const handleManualCoordChange = (latVal: string, lngVal: string) => {
    const lat = latVal ? parseFloat(latVal) : null;
    const lng = lngVal ? parseFloat(lngVal) : null;
    setCurrentLat(lat);
    setCurrentLng(lng);
    onCoordinatesChange(lat, lng);

    if (isMapsLoaded && markerInstanceRef.current && lat !== null && lng !== null) {
      const pos = new window.google.maps.LatLng(lat, lng);
      markerInstanceRef.current.setPosition(pos);
      mapInstanceRef.current?.setCenter(pos);
    }
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Places Autocomplete Search Bar */}
      {apiKey && !mapError ? (
        <div className="space-y-1">
          <Label htmlFor="google-places-search" className="text-xs font-medium flex items-center gap-1.5">
            <Search className="size-3.5 text-primary" />
            Search Address with Google Places Autocomplete
          </Label>
          <div className="relative">
            <Input
              id="google-places-search"
              ref={autocompleteInputRef}
              type="text"
              placeholder="Search by building, street, or landmark..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 text-sm"
            />
            <Search className="size-4 absolute left-2.5 top-2.5 text-muted-foreground pointer-events-none" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Selecting a place will automatically populate street, city, state, postal code, and coordinates.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-border/80 bg-muted/40 p-2.5 text-xs text-muted-foreground flex items-start gap-2">
          <AlertCircle className="size-4 shrink-0 text-muted-foreground mt-0.5" />
          <div>
            <span className="font-medium text-foreground">Manual Address Mode: </span>
            {apiKey
              ? 'Google Maps SDK unavailable; manual address entry is active.'
              : 'Google Maps API key (VITE_GOOGLE_MAPS_API_KEY) is not set. All address features remain fully operational via manual entry.'}
          </div>
        </div>
      )}

      {/* Interactive Map Canvas (when Google Maps is available) */}
      {isMapsLoaded && apiKey && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <MapPin className="size-3.5 text-primary" />
              Pinpoint on Map (Drag marker to adjust)
            </span>
            {currentLat && currentLng && (
              <span className="text-[11px] font-mono">
                {currentLat.toFixed(5)}, {currentLng.toFixed(5)}
              </span>
            )}
          </div>
          <div
            ref={mapContainerRef}
            className="w-full h-44 rounded-md border border-border bg-muted overflow-hidden shadow-inner"
            aria-label="Google Map Picker"
          />
        </div>
      )}

      {/* Optional Coordinates Fine-Tuning */}
      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/50">
        <div>
          <Label htmlFor="addr-lat" className="text-[11px] text-muted-foreground">
            Latitude (optional)
          </Label>
          <Input
            id="addr-lat"
            type="number"
            step="any"
            placeholder="e.g. 37.7749"
            value={currentLat ?? ''}
            onChange={(e) => handleManualCoordChange(e.target.value, String(currentLng ?? ''))}
            className="h-7 text-xs font-mono"
          />
        </div>
        <div>
          <Label htmlFor="addr-lng" className="text-[11px] text-muted-foreground">
            Longitude (optional)
          </Label>
          <Input
            id="addr-lng"
            type="number"
            step="any"
            placeholder="e.g. -122.4194"
            value={currentLng ?? ''}
            onChange={(e) => handleManualCoordChange(String(currentLat ?? ''), e.target.value)}
            className="h-7 text-xs font-mono"
          />
        </div>
      </div>
    </div>
  );
};
