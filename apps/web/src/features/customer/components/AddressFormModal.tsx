import React, { useState } from 'react';
import { X, MapPin, Building, Home, Briefcase } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input, Label } from '../../../components/ui/input';
import { Alert } from '../../../components/ui/alert';
import {
  addressesApi,
  type AddressLabel,
  type CustomerAddressDto,
  type CreateAddressInput,
} from '../api/addresses';
import { GoogleAddressPicker, type PlaceSelectionResult } from './GoogleAddressPicker';

interface AddressFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (address: CustomerAddressDto) => void;
  initialData?: CustomerAddressDto | null;
}

export const AddressFormModal: React.FC<AddressFormModalProps> = ({
  isOpen,
  onClose,
  onSaved,
  initialData,
}) => {
  if (!isOpen) return null;

  const isEditing = Boolean(initialData);

  const [label, setLabel] = useState<AddressLabel>(initialData?.label || 'Home');
  const [recipientName, setRecipientName] = useState(initialData?.recipientName || '');
  const [phone, setPhone] = useState(initialData?.phone || '');
  const [addressLine1, setAddressLine1] = useState(initialData?.addressLine1 || '');
  const [addressLine2, setAddressLine2] = useState(initialData?.addressLine2 || '');
  const [landmark, setLandmark] = useState(initialData?.landmark || '');
  const [city, setCity] = useState(initialData?.city || '');
  const [state, setState] = useState(initialData?.state || '');
  const [postalCode, setPostalCode] = useState(initialData?.postalCode || '');
  const [country, setCountry] = useState(initialData?.country || 'US');
  const [latitude, setLatitude] = useState<number | null>(initialData?.latitude ?? null);
  const [longitude, setLongitude] = useState<number | null>(initialData?.longitude ?? null);
  const [googlePlaceId, setGooglePlaceId] = useState<string | null>(initialData?.googlePlaceId ?? null);
  const [formattedAddress, setFormattedAddress] = useState<string | null>(initialData?.formattedAddress ?? null);
  const [isDefault, setIsDefault] = useState<boolean>(initialData?.isDefault ?? false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePlaceSelect = (place: PlaceSelectionResult) => {
    if (place.addressLine1) setAddressLine1(place.addressLine1);
    if (place.city) setCity(place.city);
    if (place.state) setState(place.state);
    if (place.postalCode) setPostalCode(place.postalCode);
    if (place.country) setCountry(place.country);
    setLatitude(place.latitude);
    setLongitude(place.longitude);
    setGooglePlaceId(place.googlePlaceId);
    setFormattedAddress(place.formattedAddress);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!recipientName.trim()) {
      setError('Recipient name is required');
      return;
    }
    if (!phone.trim()) {
      setError('Phone number is required');
      return;
    }
    if (!addressLine1.trim()) {
      setError('Street address is required');
      return;
    }
    if (!city.trim()) {
      setError('City is required');
      return;
    }
    if (!state.trim()) {
      setError('State/Province is required');
      return;
    }
    if (!postalCode.trim()) {
      setError('Postal code is required');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: CreateAddressInput = {
        label,
        recipientName: recipientName.trim(),
        phone: phone.trim(),
        addressLine1: addressLine1.trim(),
        addressLine2: addressLine2.trim() || null,
        landmark: landmark.trim() || null,
        city: city.trim(),
        state: state.trim(),
        postalCode: postalCode.trim(),
        country: country.trim() || 'US',
        latitude,
        longitude,
        googlePlaceId,
        formattedAddress,
        isDefault,
      };

      let result: CustomerAddressDto;
      if (isEditing && initialData) {
        result = await addressesApi.updateAddress(initialData.id, payload);
      } else {
        result = await addressesApi.createAddress(payload);
      }

      onSaved(result);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save address');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Close dialog"
        >
          <X className="size-5" />
        </button>

        <div className="mb-4">
          <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <MapPin className="size-5 text-primary" />
            {isEditing ? 'Edit Address' : 'Add New Address'}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Save delivery location with Google Maps verification or manual entry.
          </p>
        </div>

        {error && (
          <Alert tone="error" className="mb-4">
            {error}
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Label Selector Pills */}
          <div>
            <Label className="text-xs font-medium mb-1.5 block">Address Type</Label>
            <div className="flex gap-2">
              {(
                [
                  { value: 'Home', icon: Home, text: 'Home' },
                  { value: 'Work', icon: Briefcase, text: 'Work' },
                  { value: 'Other', icon: Building, text: 'Other' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setLabel(opt.value)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border py-2 px-3 text-xs font-medium transition-colors ${
                    label === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <opt.icon className="size-3.5" />
                  {opt.text}
                </button>
              ))}
            </div>
          </div>

          {/* Google Places & Map Picker */}
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <GoogleAddressPicker
              initialLat={latitude}
              initialLng={longitude}
              onPlaceSelect={handlePlaceSelect}
              onCoordinatesChange={(lat, lng) => {
                setLatitude(lat);
                setLongitude(lng);
              }}
            />
          </div>

          {/* Contact Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="addr-recipient" className="text-xs font-medium">
                Recipient Name *
              </Label>
              <Input
                id="addr-recipient"
                required
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder="Full Name"
                className="mt-1 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="addr-phone" className="text-xs font-medium">
                Contact Phone *
              </Label>
              <Input
                id="addr-phone"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555-0123"
                className="mt-1 text-sm"
              />
            </div>
          </div>

          {/* Street Address Lines */}
          <div>
            <Label htmlFor="addr-line1" className="text-xs font-medium">
              Address Line 1 (Street & House #) *
            </Label>
            <Input
              id="addr-line1"
              required
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
              placeholder="123 Main Street"
              className="mt-1 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="addr-line2" className="text-xs font-medium">
                Address Line 2 (Apt, Suite, Floor)
              </Label>
              <Input
                id="addr-line2"
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                placeholder="Apt 4B"
                className="mt-1 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="addr-landmark" className="text-xs font-medium">
                Landmark (Optional)
              </Label>
              <Input
                id="addr-landmark"
                value={landmark}
                onChange={(e) => setLandmark(e.target.value)}
                placeholder="Near Central Park"
                className="mt-1 text-sm"
              />
            </div>
          </div>

          {/* City, State, Postal Code, Country */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="col-span-1 sm:col-span-1">
              <Label htmlFor="addr-city" className="text-xs font-medium">
                City *
              </Label>
              <Input
                id="addr-city"
                required
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="mt-1 text-sm"
              />
            </div>
            <div className="col-span-1 sm:col-span-1">
              <Label htmlFor="addr-state" className="text-xs font-medium">
                State *
              </Label>
              <Input
                id="addr-state"
                required
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="mt-1 text-sm"
              />
            </div>
            <div className="col-span-1 sm:col-span-1">
              <Label htmlFor="addr-zip" className="text-xs font-medium">
                PIN / Zip *
              </Label>
              <Input
                id="addr-zip"
                required
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                className="mt-1 text-sm"
              />
            </div>
            <div className="col-span-1 sm:col-span-1">
              <Label htmlFor="addr-country" className="text-xs font-medium">
                Country
              </Label>
              <Input
                id="addr-country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="mt-1 text-sm"
              />
            </div>
          </div>

          {/* Default Address Checkbox */}
          <label className="flex items-center gap-2.5 cursor-pointer pt-2">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="size-4 accent-primary rounded"
            />
            <span className="text-xs font-medium text-foreground">
              Make this my default shipping address
            </span>
          </label>

          {/* Modal Actions */}
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : isEditing ? 'Update Address' : 'Save Address'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
