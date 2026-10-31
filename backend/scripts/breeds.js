// Starter breed lists for the Add a pet form (GET /pets/breeds), in display order. Both seed
// scripts use them. Re-running only adds breeds that are missing; existing ones are left alone.
import { Breed } from '../src/modules/pets/pet.model.js';

export const BREEDS = {
  dog: ['Golden Retriever', 'Labrador', 'Indie', 'Beagle'],
  cat: ['Indian shorthair', 'Persian', 'Siamese', 'Maine Coon'],
  bird: ['Budgerigar', 'Cockatiel', 'Lovebird', 'Indian ringneck'],
  small_animal: ['Rabbit', 'Guinea pig', 'Hamster'],
};

// Call inside a tenant context (runWithTenant).
export async function seedBreeds() {
  for (const [species, names] of Object.entries(BREEDS)) {
    for (const [sortOrder, name] of names.entries()) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await Breed.updateOne({ species, slug }, { $setOnInsert: { species, slug, name, sortOrder } }, { upsert: true });
    }
  }
}
