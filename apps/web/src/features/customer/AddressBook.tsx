import React, { useEffect, useState } from 'react';
import {
  MapPin,
  Home,
  Briefcase,
  Building,
  Plus,
  Trash2,
  Edit2,
  Check,
  Star,
  Compass,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { Skeleton, EmptyState } from '../../components/ui/empty';
import {
  addressesApi,
  type CustomerAddressDto,
  type AddressLabel,
} from './api/addresses';
import { AddressFormModal } from './components/AddressFormModal';

export const AddressBook: React.FC<{
  onSelectAddress?: (address: CustomerAddressDto) => void;
  selectedAddressId?: string | null;
}> = ({ onSelectAddress, selectedAddressId }) => {
  const [addresses, setAddresses] = useState<CustomerAddressDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<CustomerAddressDto | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadAddresses = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await addressesApi.listAddresses();
      setAddresses(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load address book');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAddresses();
  }, []);

  const handleOpenAdd = () => {
    setEditingAddress(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (addr: CustomerAddressDto) => {
    setEditingAddress(addr);
    setIsModalOpen(true);
  };

  const handleSetDefault = async (id: string) => {
    try {
      await addressesApi.setDefaultAddress(id);
      setSuccessMsg('Default address updated.');
      setTimeout(() => setSuccessMsg(null), 3000);
      await loadAddresses();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not set default address');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this address?')) {
      return;
    }
    setDeletingId(id);
    try {
      await addressesApi.deleteAddress(id);
      setSuccessMsg('Address removed.');
      setTimeout(() => setSuccessMsg(null), 3000);
      await loadAddresses();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete address');
    } finally {
      setDeletingId(null);
    }
  };

  const getLabelIcon = (label: AddressLabel) => {
    switch (label) {
      case 'Home':
        return <Home className="size-3.5 text-primary" />;
      case 'Work':
        return <Briefcase className="size-3.5 text-primary" />;
      default:
        return <Building className="size-3.5 text-primary" />;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-2">
            <MapPin className="size-4 text-primary" />
            Saved Addresses
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage your delivery locations for faster checkout.
          </p>
        </div>
        <Button size="sm" onClick={handleOpenAdd} className="flex items-center gap-1.5">
          <Plus className="size-4" />
          Add Address
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {successMsg && <Alert tone="success">{successMsg}</Alert>}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : addresses.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No addresses saved yet"
          description="Add your home, office, or favorite delivery locations."
          actionLabel="Add Address"
          onAction={handleOpenAdd}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {addresses.map((addr) => {
            const isSelected = selectedAddressId === addr.id;
            return (
              <Card
                key={addr.id}
                className={`relative transition-all border ${
                  isSelected
                    ? 'border-primary shadow-sm bg-primary/5'
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <CardContent className="p-4 flex flex-col justify-between h-full space-y-3">
                  {/* Card Header: Label & Default Badge */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="p-1 rounded-md bg-primary/10">
                        {getLabelIcon(addr.label)}
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-wider">
                        {addr.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {addr.isDefault && (
                        <Badge variant="success" className="text-[10px] font-semibold">
                          <Check className="size-3 mr-0.5" />
                          Default
                        </Badge>
                      )}
                      {isSelected && (
                        <Badge variant="default" className="text-[10px] font-semibold bg-primary text-primary-foreground">
                          Selected
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Recipient & Full Address */}
                  <div className="space-y-1 text-xs">
                    <p className="font-semibold text-sm text-foreground">
                      {addr.recipientName}
                    </p>
                    <p className="text-muted-foreground">{addr.phone}</p>
                    <p className="text-muted-foreground leading-relaxed pt-1">
                      {addr.addressLine1}
                      {addr.addressLine2 ? `, ${addr.addressLine2}` : ''}
                      {addr.landmark ? ` (Near ${addr.landmark})` : ''}
                      <br />
                      {addr.city}, {addr.state} - {addr.postalCode}
                      <br />
                      {addr.country}
                    </p>
                    {addr.latitude !== null && addr.latitude !== undefined && (
                      <div className="pt-1 flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
                        <Compass className="size-3 text-primary" />
                        <span>
                          {Number(addr.latitude).toFixed(4)}, {Number(addr.longitude).toFixed(4)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Card Actions */}
                  <div className="pt-2 border-t border-border/60 flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      {!addr.isDefault && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleSetDefault(addr.id)}
                          className="h-7 px-2 text-[11px]"
                        >
                          <Star className="size-3 mr-1" />
                          Set Default
                        </Button>
                      )}
                      {onSelectAddress && !isSelected && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onSelectAddress(addr)}
                          className="h-7 px-2 text-[11px]"
                        >
                          Select
                        </Button>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleOpenEdit(addr)}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        aria-label="Edit address"
                      >
                        <Edit2 className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deletingId === addr.id}
                        onClick={() => handleDelete(addr.id)}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        aria-label="Delete address"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Address Form Dialog Modal */}
      <AddressFormModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSaved={() => {
          loadAddresses();
        }}
        initialData={editingAddress}
      />
    </div>
  );
};
