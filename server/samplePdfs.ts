/**
 * Generates valid standard multi-page PDF documents for instant testing without external dependencies.
 */

function escapePdfText(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

interface PdfPageContent {
  title: string;
  subtitle?: string;
  sections: { heading: string; body: string[] }[];
}

export function createMinimalPdf(title: string, pages: PdfPageContent[]): string {
  const objects: string[] = [];

  // Object 1: Catalog
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`);

  // Object 2: Pages
  const pageObjectIds = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds}] /Count ${pages.length} >>\nendobj`);

  // Object font: Font Helvetica
  const fontObjId = 3 + pages.length * 2;

  pages.forEach((page, index) => {
    const pageObjId = 3 + index * 2;
    const contentObjId = pageObjId + 1;

    // Page object
    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjId} 0 R /Resources << /Font << /F1 ${fontObjId} 0 R >> >> >>\nendobj`
    );

    // Stream commands
    const streamLines: string[] = [
      'BT',
      '/F1 18 Tf',
      '50 740 Td',
      `(${escapePdfText(page.title)}) Tj`,
    ];

    if (page.subtitle) {
      streamLines.push('/F1 12 Tf', '0 -22 Td', `(${escapePdfText(page.subtitle)}) Tj`);
    }

    streamLines.push('/F1 9 Tf', '0 -15 Td', `(Page ${index + 1} of ${pages.length} - ${escapePdfText(title)}) Tj`);

    let currentOffset = -25;
    page.sections.forEach((sec) => {
      streamLines.push('/F1 13 Tf', `0 ${currentOffset} Td`, `(${escapePdfText(sec.heading)}) Tj`);
      currentOffset = -18;
      sec.body.forEach((para) => {
        streamLines.push('/F1 10 Tf', `0 ${currentOffset} Td`, `(${escapePdfText(para)}) Tj`);
        currentOffset = -14;
      });
      currentOffset = -22;
    });

    streamLines.push('ET');
    const streamContent = streamLines.join('\n');
    objects.push(
      `${contentObjId} 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'utf-8')} >>\nstream\n${streamContent}\nendstream\nendobj`
    );
  });

  // Font object
  objects.push(`${fontObjId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);

  // Assemble full PDF
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  objects.forEach((obj, idx) => {
    offsets.push(Buffer.byteLength(pdf, 'utf-8'));
    pdf += obj + '\n';
  });

  const xrefOffset = Buffer.byteLength(pdf, 'utf-8');
  pdf += 'xref\n';
  pdf += `0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    const off = offsets[i].toString().padStart(10, '0');
    pdf += `${off} 00000 n \n`;
  }

  pdf += 'trailer\n';
  pdf += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += 'startxref\n';
  pdf += `${xrefOffset}\n`;
  pdf += '%%EOF';

  return Buffer.from(pdf, 'utf-8').toString('base64');
}

export interface SampleDoc {
  id: string;
  name: string;
  description: string;
  category: string;
  pageCount: number;
  base64: string;
  suggestedQuestions: string[];
}

export const SAMPLE_DOCUMENTS: SampleDoc[] = [
  {
    id: 'sample-energy-2026',
    name: 'EcoGrid Global Energy Report 2026.pdf',
    description: 'Annual corporate report on global clean energy transitions, grid modernization, and emissions milestones.',
    category: 'Energy & Sustainability',
    pageCount: 4,
    suggestedQuestions: [
      'What was the total solar capacity added in 2025?',
      'What are the water reduction targets for data centers on page 2?',
      'What is the planned investment in grid-scale battery storage?',
      'By what year does the roadmap commit to reaching net-zero carbon?',
    ],
    base64: createMinimalPdf('EcoGrid Global Energy Report 2026', [
      {
        title: 'EcoGrid Clean Energy Report 2026',
        subtitle: 'Executive Summary & Global Generation Overview',
        sections: [
          {
            heading: '1. Executive Summary',
            body: [
              'In fiscal year 2025, EcoGrid achieved a milestone of 42.8 gigawatts (GW) in total renewable energy capacity.',
              'Total solar photovoltaic installations accounted for 24.5 GW of added capacity, representing a 31% year-over-year increase.',
              'Wind power generation reached 18.3 GW across 14 operational offshore and onshore installations in North America and Europe.',
              'Global carbon intensity fell to 182 grams of CO2 equivalent per kilowatt-hour, outperforming regulatory mandates by 19%.',
            ],
          },
          {
            heading: '2. Key Operational Highlights',
            body: [
              'Capital expenditures for renewable generation reached $4.2 billion, with $2.8 billion allocated to utility-scale solar farms.',
              'Operational uptime across automated substations remained at 99.98% throughout peak severe weather incidents.',
            ],
          },
        ],
      },
      {
        title: 'EcoGrid Clean Energy Report 2026',
        subtitle: 'Data Center Cooling & Resource Efficiency',
        sections: [
          {
            heading: '3. Data Center Water Conservation Targets',
            body: [
              'EcoGrid mandates a strict Water Usage Effectiveness (WUE) target of 0.18 liters per kilowatt-hour across all tier-4 facilities.',
              'By end of Q3 2026, closed-loop adiabatic cooling systems will reduce municipal freshwater consumption by 45%.',
              'Rainwater reclamation harvesting systems are now operational at the Dublin, Frankfurt, and Oregon hyperscale campus locations.',
              'A baseline target of zero potable water usage for industrial server cooling is legally scheduled for fulfillment by 2028.',
            ],
          },
          {
            heading: '4. Thermal Envelope Optimization',
            body: [
              'Ambient intake operating temperatures have been elevated safely to 27 degrees Celsius, curtailing mechanical chiller runtime by 350 hours annually.',
            ],
          },
        ],
      },
      {
        title: 'EcoGrid Clean Energy Report 2026',
        subtitle: 'Battery Energy Storage Systems (BESS)',
        sections: [
          {
            heading: '5. Grid-Scale Battery Storage Investment',
            body: [
              'The Board has approved a dedicated $1.65 billion capital expenditure commitment for Grid-Scale Battery Energy Storage Systems (BESS).',
              'A total of 8.4 gigawatt-hours (GWh) of lithium iron phosphate (LFP) storage assets will be deployed across six regional transmission interconnects.',
              'Average battery round-trip electrical efficiency for the newly commissioned Megapack clusters measured at 89.4%.',
              'Storage reserves can supply continuous power to over 650,000 homes for up to four consecutive hours during grid curtailment events.',
            ],
          },
          {
            heading: '6. Safety & Degradation Protocols',
            body: [
              'Cell-level immersion liquid cooling prevents thermal runaway propagation and guarantees a 15-year operational lifespan exceeding 4,000 cycles.',
            ],
          },
        ],
      },
      {
        title: 'EcoGrid Clean Energy Report 2026',
        subtitle: '2030 Net-Zero Decarbonization Roadmap',
        sections: [
          {
            heading: '7. Carbon Neutrality Commitments',
            body: [
              'The definitive roadmap commits EcoGrid to achieving verified Net-Zero Carbon status across Scopes 1 and 2 by the year 2030.',
              'Scope 3 supply chain emissions will be curtailed by a minimum of 60% compared to the 2021 audited baseline.',
              'Green hydrogen pilot turbines will begin co-firing at 20% hydrogen blend at the Mojave peaking station starting in September 2027.',
              'Independent third-party verification of emission credits is certified under ISO 14064-3 standards.',
            ],
          },
        ],
      },
    ]),
  },
  {
    id: 'sample-drone-manual',
    name: 'AeroX-900 Drone Operator Manual.pdf',
    description: 'Technical and operational field manual for industrial survey UAV, including pre-flight, emergency, and battery protocols.',
    category: 'Technical Manual',
    pageCount: 4,
    suggestedQuestions: [
      'What is the maximum wind speed tolerance for takeoff?',
      'What are the emergency Return-To-Launch (RTL) trigger conditions?',
      'What is the maximum safe operating temperature for the battery?',
      'What is the recommended payload weight limit?',
    ],
    base64: createMinimalPdf('AeroX-900 Drone Operator Manual', [
      {
        title: 'AeroX-900 Heavy-Lift UAV Manual',
        subtitle: 'Specifications & Operational Limitations',
        sections: [
          {
            heading: '1. Aircraft Performance Specifications',
            body: [
              'The AeroX-900 is an enterprise hexacopter designed for airborne LiDAR, multispectral imaging, and industrial asset inspection.',
              'Maximum takeoff weight (MTOW) is 14.8 kg, with a maximum rated payload capacity of 4.5 kg.',
              'Maximum wind speed tolerance for safe takeoff and landing is 12.5 meters per second (approx. 28 mph or 24.3 knots).',
              'Cruising airspeed is 15 m/s, with an electronically governed maximum horizontal speed of 22 m/s in Sport mode.',
              'Operational service ceiling is 4,500 meters above sea level with high-altitude carbon fiber folding propellers installed.',
            ],
          },
        ],
      },
      {
        title: 'AeroX-900 Heavy-Lift UAV Manual',
        subtitle: 'Pre-Flight Checklist & Calibration',
        sections: [
          {
            heading: '2. Pre-Flight Inspection Protocol',
            body: [
              'Verify dual RTK GPS locks with a minimum satellite constellation count of 18 satellites and an HDOP reading below 0.9.',
              'Inspect all six quick-release brushless motor mounts for torque tension; verify motor bearings show no axial play.',
              'Calibrate magnetic compass if the operational takeoff location has shifted by more than 50 kilometers from prior calibration.',
              'Confirm obstacle avoidance LiDAR sensors on front, rear, and downward arrays are clear of dust, moisture, and debris.',
            ],
          },
        ],
      },
      {
        title: 'AeroX-900 Heavy-Lift UAV Manual',
        subtitle: 'Fail-Safe Systems & Emergency Procedures',
        sections: [
          {
            heading: '3. Return-To-Launch (RTL) Automated Triggers',
            body: [
              'An automatic Return-To-Launch (RTL) maneuver is triggered if the 2.4/5.8 GHz control link experiences continuous signal loss exceeding 3.0 seconds.',
              'RTL automatically initiates when battery state of charge (SoC) drops below 22% or remaining flight time equals return transit time plus 3 minutes margin.',
              'Upon RTL trigger, the aircraft climbs to the preset failsafe altitude of 60 meters above ground level before beginning direct waypoint transit.',
              'If GPS position signal degrades completely during emergency transit, the aircraft switches to ATTI mode and performs controlled vertical descent.',
            ],
          },
        ],
      },
      {
        title: 'AeroX-900 Heavy-Lift UAV Manual',
        subtitle: 'Battery Care & Thermal Management',
        sections: [
          {
            heading: '4. High-Capacity Smart Battery Guidelines',
            body: [
              'The drone is powered by two 12S 22,000mAh solid-state lithium-polymer packs wired in parallel for redundancy.',
              'The maximum safe operating temperature for the battery packs is 50 degrees Celsius (122 degrees Fahrenheit).',
              'If internal cell temperature exceeds 55 degrees Celsius in flight, an amber thermal warning alerts the pilot ground station immediately.',
              'Do not charge batteries if core temperature is below 5 degrees Celsius; utilize built-in self-heating jackets prior to fast charging.',
              'Storage discharge state: if stored for over 72 hours, the intelligent battery management circuit self-discharges cells to 3.85V per cell.',
            ],
          },
        ],
      },
    ]),
  },
  {
    id: 'sample-security-policy',
    name: 'QuantumLeap Cybersecurity & Compliance Policy.pdf',
    description: 'Corporate information security guidelines covering encryption requirements, incident response, and access control.',
    category: 'Corporate Policy',
    pageCount: 3,
    suggestedQuestions: [
      'What encryption standard is mandated for data at rest?',
      'Within how many hours must a confirmed data breach be reported to authorities?',
      'What are the mandatory rules for multi-factor authentication (MFA)?',
    ],
    base64: createMinimalPdf('QuantumLeap Cybersecurity & Compliance Policy', [
      {
        title: 'QuantumLeap Information Security Policy',
        subtitle: 'Data Classification & Cryptographic Standards',
        sections: [
          {
            heading: '1. Cryptographic Standards for Data at Rest and in Transit',
            body: [
              'All corporate and customer data stored at rest must be encrypted using AES-256 with managed customer encryption keys (CMEK).',
              'Keys must be rotated automatically every 90 days via Hardware Security Modules (HSM) certified under FIPS 140-3 Level 3.',
              'All network communications in transit must enforce TLS version 1.3 minimum with forward secrecy cipher suites.',
              'Legacy protocols including SSLv3, TLS 1.0, and unencrypted HTTP/FTP are permanently blocked at the perimeter edge proxies.',
            ],
          },
        ],
      },
      {
        title: 'QuantumLeap Information Security Policy',
        subtitle: 'Identity, Access Management & Authentication',
        sections: [
          {
            heading: '2. Multi-Factor Authentication (MFA) Requirements',
            body: [
              'Hardware security keys (FIDO2 / WebAuthn standard) are mandatory for all production cloud infrastructure and code repository access.',
              'SMS-based two-factor authentication and voice call verifications are strictly prohibited due to SIM-swapping vulnerabilities.',
              'Session timeouts: administrative consoles must enforce mandatory re-authentication after 15 minutes of user inactivity.',
              'Privileged access credentials expire automatically after 8 hours and require ticket-based just-in-time (JIT) approvals.',
            ],
          },
        ],
      },
      {
        title: 'QuantumLeap Information Security Policy',
        subtitle: 'Incident Response & Regulatory Reporting',
        sections: [
          {
            heading: '3. Data Breach Notification Timelines',
            body: [
              'In the event of a confirmed security incident involving unauthorized PII access, the incident commander must notify executive legal within 2 hours.',
              'Regulatory supervisory authorities and data protection commissioners must be officially notified within 72 hours of incident confirmation.',
              'Affected customers and enterprise partners must receive formal written disclosure within 5 business days of containment verification.',
              'Full post-mortem forensic reports must be archived and presented to the audit committee within 14 calendar days.',
            ],
          },
        ],
      },
    ]),
  },
];
