export function tenantDocPath(tenantId: string) {
  return `tenants/${tenantId}`;
}

export function tenantSubcollectionPath(tenantId: string, collection: string) {
  return `tenants/${tenantId}/${collection}`;
}

export function tenantSubdocPath(tenantId: string, collection: string, docId: string) {
  return `tenants/${tenantId}/${collection}/${docId}`;
}
