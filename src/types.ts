import type {
    AbuseContact, Asn, AsnLookupResponse, AsnPrefix, BitTorrentDetail, CarrierDetail, ClassDetail, Company,
    Database, DatabaseFormat, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion, DbChecksums,
    DisposableDetail, DnsAddressRecord, DnsCnameRecord, DnsMxRecord, DnsNsRecord, DnsResolverDetail, DomainDns,
    DomainIpRange, DomainIpRanges, DomainLookupResponse, Download, Entitlement, EntitlementApikey,
    EntitlementPlan, EntitlementUsage, HostedDomains, Location, LookupResponse, ProxyDetail, PubproxyDetail,
    Rwhois, SatelliteDetail, SmtpDetail, SshDetail, Standing, WebDetail, Whois,
} from './generated/types.gen.js';

export type {
    AbuseContact, Asn, AsnLookupResponse, AsnPrefix, BitTorrentDetail, CarrierDetail, ClassDetail, Company,
    Database, DatabaseFormat, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion, DbChecksums,
    DisposableDetail, DnsAddressRecord, DnsCnameRecord, DnsMxRecord, DnsNsRecord, DnsResolverDetail, DomainDns,
    DomainIpRange, DomainIpRanges, DomainLookupResponse, Download, Entitlement, EntitlementApikey,
    EntitlementPlan, EntitlementUsage, HostedDomains, Location, LookupResponse, ProxyDetail, PubproxyDetail,
    Rwhois, SatelliteDetail, SmtpDetail, SshDetail, Standing, WebDetail, Whois,
};

/** What a license permits you to do with the data. `null` when there is none. */
export type LicenseType = Database['license_type'];

/**
 * @deprecated Use {@link DatabaseFormat}. Kept so existing imports keep
 * compiling; this brand's Java, .NET and Swift SDKs have always called it
 * `DatabaseFormat`, and so does every VPNDetection SDK.
 */
export type DatasetFormat = DatabaseFormat;

// The runtime halves of the three closed vocabularies above, for a caller that
// wants to validate or enumerate rather than switch. Each is TYPED by the
// generated union, so a value the spec does not define will not compile; that a
// value is MISSING is what the shared conformance corpus pins.
export const DATABASE_FORMATS: readonly DatabaseFormat[] = ['csvgz', 'mmdb'];

/** @deprecated Use {@link DATABASE_FORMATS}. */
export const DATASET_FORMATS: readonly DatabaseFormat[] = DATABASE_FORMATS;
export const STANDINGS: readonly Standing[] = ['licensed', 'expired', 'unlicensed'];
export const LICENSE_TYPES: readonly NonNullable<LicenseType>[] = [
    'evaluation', 'standard', 'redistribute',
];

/**
 * What a lookup answers about one address.
 *
 * An **optional** member is one your plan does not include. It never means "we
 * could not check", so `undefined` and `false` are genuinely different answers:
 * `undefined` is "not in your plan", `false` is "checked, and no". Use
 * `?? false` when you only care whether the address is flagged. The same holds
 * inside `location`, `asn`, `company` and `abuse`, whose paid members are
 * absent on Unlimited.
 *
 * A detail object that is present but empty (`{}`, and Web IP's `[]`) means the
 * flag above it is false. A populated one always carries every one of its keys.
 */
export interface Result {
    /** The address that was looked up, as parsed: `::ffff:a.b.c.d` answers as `a.b.c.d`. */
    ip: string;
    /** Reserved space, answered from the address alone. Such an address never reaches the network. */
    isBogon: boolean;

    isVpn?: boolean;
    isTor: boolean;
    isRelay: boolean;
    isResproxy?: boolean;
    isDcproxy?: boolean;
    isMobproxy?: boolean;
    isPubproxy?: boolean;
    isHosting?: boolean;
    isCdn?: boolean;
    isAnycast: boolean;
    isCarrier: boolean;
    isSatellite: boolean;
    isSsh: boolean;
    isSmtp: boolean;
    isWeb: boolean;
    isDnsResolver: boolean;
    isBittorrent: boolean;
    /**
     * On answers to a key on the free plan only: `false` while the day's trial of
     * every field lasts, `true` once the answer has Unlimited's.
     */
    trialExpired?: boolean;

    vpn?: ClassDetail;
    tor: ClassDetail;
    relay: ClassDetail;
    resproxy?: ProxyDetail;
    dcproxy?: ProxyDetail;
    mobproxy?: ProxyDetail;
    pubproxy?: PubproxyDetail;
    hosting?: ClassDetail;
    cdn?: ClassDetail;
    carrier?: CarrierDetail;
    satellite?: SatelliteDetail;
    ssh?: SshDetail;
    smtp?: SmtpDetail;
    /** A row per port that answered, lowest first. */
    web?: WebDetail[];
    dnsResolver?: DnsResolverDetail;
    bittorrent?: BitTorrentDetail;

    location: Location;
    asn: Asn;
    company: Company;
    /** The name the address's reverse DNS (PTR) record points to, empty when it has none. */
    hostname: string;
    abuse: AbuseContact;
    whois?: Whois;
    rwhois?: Rwhois;
    hostedDomains?: HostedDomains;

    /** The response exactly as it came off the wire, with its original names. */
    raw: LookupResponse;
}

/** What `lookupAsn` answers. An optional member is one your plan does not include, as on `Result`. */
export interface AsnResult {
    asn: number;
    name: string;
    country: string;
    registry: string;
    allocated: string;
    domain: string;
    type?: string;
    numIps?: number;
    numPrefixes4?: number;
    numPrefixes6?: number;
    rpkiValid?: number;
    rpkiInvalid?: number;
    rpkiNotFound?: number;
    whois?: { [key: string]: string };
    prefixes?: AsnPrefix[];
    trialExpired?: boolean;
    /** The response exactly as it came off the wire, with its original names. */
    raw: AsnLookupResponse;
}

/** What `lookupDomain` answers. An optional member is one your plan does not include, as on `Result`. */
export interface DomainResult {
    domain: string;
    isRegistered: boolean;
    isDisposable?: boolean;
    hasA: boolean;
    hasAaaa: boolean;
    hasMx: boolean;
    hasNs: boolean;
    hasCname: boolean;
    dns?: DomainDns;
    ipRanges?: DomainIpRanges;
    /** `{}` when `isDisposable` is false. */
    disposable?: DisposableDetail;
    trialExpired?: boolean;
    /** The response exactly as it came off the wire, with its original names. */
    raw: DomainLookupResponse;
}

// The one place the wire's snake_case becomes idiomatic camelCase. Every member
// is copied when its key is PRESENT rather than truthy, so a plan that includes a
// field and answers `false` keeps it, and a plan that does not include it stays
// undefined. A member the spec adds fails to compile here until it is named.
const RESULT_NAMES: Record<keyof LookupResponse, Exclude<keyof Result, 'raw'>> = {
    ip: 'ip', is_bogon: 'isBogon', is_vpn: 'isVpn', is_tor: 'isTor', is_relay: 'isRelay',
    is_resproxy: 'isResproxy', is_dcproxy: 'isDcproxy', is_mobproxy: 'isMobproxy', is_pubproxy: 'isPubproxy',
    is_hosting: 'isHosting', is_cdn: 'isCdn', is_anycast: 'isAnycast', is_carrier: 'isCarrier',
    is_satellite: 'isSatellite', is_ssh: 'isSsh', is_smtp: 'isSmtp', is_web: 'isWeb',
    is_dns_resolver: 'isDnsResolver', is_bittorrent: 'isBittorrent', trial_expired: 'trialExpired',
    vpn: 'vpn', tor: 'tor', relay: 'relay', resproxy: 'resproxy', dcproxy: 'dcproxy', mobproxy: 'mobproxy',
    pubproxy: 'pubproxy', hosting: 'hosting', cdn: 'cdn', carrier: 'carrier', satellite: 'satellite', ssh: 'ssh',
    smtp: 'smtp', web: 'web', dns_resolver: 'dnsResolver', bittorrent: 'bittorrent', location: 'location',
    asn: 'asn', company: 'company', hostname: 'hostname', abuse: 'abuse', whois: 'whois', rwhois: 'rwhois',
    hosted_domains: 'hostedDomains',
};

const ASN_RESULT_NAMES: Record<keyof AsnLookupResponse, Exclude<keyof AsnResult, 'raw'>> = {
    asn: 'asn', name: 'name', country: 'country', registry: 'registry', allocated: 'allocated', domain: 'domain',
    type: 'type', num_ips: 'numIps', num_prefixes4: 'numPrefixes4', num_prefixes6: 'numPrefixes6',
    rpki_valid: 'rpkiValid', rpki_invalid: 'rpkiInvalid', rpki_not_found: 'rpkiNotFound', whois: 'whois',
    prefixes: 'prefixes', trial_expired: 'trialExpired',
};

const DOMAIN_RESULT_NAMES: Record<keyof DomainLookupResponse, Exclude<keyof DomainResult, 'raw'>> = {
    domain: 'domain', is_registered: 'isRegistered', is_disposable: 'isDisposable', has_a: 'hasA',
    has_aaaa: 'hasAaaa', has_mx: 'hasMx', has_ns: 'hasNs', has_cname: 'hasCname', dns: 'dns',
    ip_ranges: 'ipRanges', disposable: 'disposable', trial_expired: 'trialExpired',
};

export function toResult(body: LookupResponse): Result {
    return renamed(body, RESULT_NAMES);
}

export function toAsnResult(body: AsnLookupResponse): AsnResult {
    return renamed(body, ASN_RESULT_NAMES);
}

export function toDomainResult(body: DomainLookupResponse): DomainResult {
    return renamed(body, DOMAIN_RESULT_NAMES);
}

function renamed<W extends object, R extends { raw: W }>(body: W, names: Record<keyof W, string>): R {
    const out: Record<string, unknown> = {};
    for (const [from, to] of Object.entries<string>(names)) {
        if (from in body && body[from as keyof W] !== undefined) {
            out[to] = body[from as keyof W];
        }
    }
    out['raw'] = body;
    return out as R;
}
