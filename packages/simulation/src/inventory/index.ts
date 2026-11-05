// Inventory pools, reservations, cargo moves, and weighted-average costing
// (T02a, GDD §8 FIN-001; release rules in ADR 0013).
export {
  addMaterial,
  addProduct,
  addReservation,
  allocateRemovalCost,
  availableMaterial,
  availableProduct,
  checkReservation,
  consumeReservations,
  findMaterialPool,
  findProductPool,
  InventoryError,
  inventoryValue,
  releaseContractReservations,
  removeMaterial,
  removeProduct,
  removeReservations,
  storageUsed,
  takeForContract,
  takeMaterial,
  takeProduct,
  type Taken,
} from "./pools.ts";
export { registerInventory, releaseRejection } from "./release.ts";
