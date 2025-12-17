export function tenantDocPath(tenantId) {
    return `tenants/${tenantId}`;
}
export function tenantSubcollectionPath(tenantId, collection) {
    return `tenants/${tenantId}/${collection}`;
}
export function tenantSubdocPath(tenantId, collection, docId) {
    return `tenants/${tenantId}/${collection}/${docId}`;
}
