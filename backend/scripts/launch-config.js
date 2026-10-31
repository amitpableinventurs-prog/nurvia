// Phase 1 launch configuration from the agreement (Annexure A1): the supported vendor categories
// and the initial city rollout. Both seed scripts use it; staff change it later in the admin panel.

export const VENDOR_CATEGORIES = [
  ['Veterinarian / Veterinary clinic', 'vet-clinic'],
  ['Groomer', 'grooming'],
  ['Boarding / Daycare', 'boarding'],
  ['Pet stay', 'pet-stay'],
  ['Trainer', 'training'],
  ['Dog walker', 'dog-walking'],
  ['Pet sitter', 'pet-sitting'],
  ['Local pet shop', 'pet-shop'],
];

const point = (lat, lng) => ({ type: 'Point', coordinates: [lng, lat] });

// Delhi NCR launches first; the other metros show "Coming soon" until Nurvia activates them.
export const CITIES = [
  {
    slug: 'delhi-ncr', name: 'Delhi NCR', region: 'Delhi', status: 'active', sortOrder: 0, center: point(28.6139, 77.209), radiusKm: 60,
    aliases: ['Delhi', 'New Delhi', 'Gurugram', 'Gurgaon', 'Noida', 'Greater Noida', 'Ghaziabad', 'Faridabad'],
  },
  { slug: 'mumbai', name: 'Mumbai', region: 'Maharashtra', status: 'coming_soon', sortOrder: 1, center: point(19.076, 72.8777), radiusKm: 45, aliases: ['Navi Mumbai', 'Thane', 'Bombay'] },
  { slug: 'bengaluru', name: 'Bengaluru', region: 'Karnataka', status: 'coming_soon', sortOrder: 2, center: point(12.9716, 77.5946), radiusKm: 40, aliases: ['Bangalore'] },
  { slug: 'hyderabad', name: 'Hyderabad', region: 'Telangana', status: 'coming_soon', sortOrder: 3, center: point(17.385, 78.4867), radiusKm: 40, aliases: ['Secunderabad'] },
];
