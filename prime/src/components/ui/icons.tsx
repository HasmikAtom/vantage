import * as React from 'react';
import { cn } from '@/lib/utils';

export interface IconProps {
  size?: number;
  className?: string;
}

interface InternalIconProps extends IconProps {
  d?: string;
  paths?: React.ReactNode;
  viewBox?: string;
}

const Icon = ({ d, paths, size = 16, className, viewBox = '0 0 24 24' }: InternalIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox={viewBox}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={cn('inline-block shrink-0', className)}
  >
    {d && <path d={d} />}
    {paths}
  </svg>
);

export const SunIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>
    }
  />
);

export const MoonIcon = (p: IconProps) => (
  <Icon {...p} d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
);

export const ChevronRightIcon = (p: IconProps) => <Icon {...p} d="m9 18 6-6-6-6" />;

export const SearchIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </>
    }
  />
);

export const ActivityIcon = (p: IconProps) => (
  <Icon {...p} d="M22 12h-4l-3 9L9 3l-3 9H2" />
);

export const CpuIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
      </>
    }
  />
);

export const ServerIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <path d="M6 6h.01M6 18h.01" />
      </>
    }
  />
);

export const NetworkIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <rect x="16" y="16" width="6" height="6" rx="1" />
        <rect x="2" y="16" width="6" height="6" rx="1" />
        <rect x="9" y="2" width="6" height="6" rx="1" />
        <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
        <path d="M12 12V8" />
      </>
    }
  />
);

export const HardDriveIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M22 12H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        <path d="M6 16h.01M10 16h.01" />
      </>
    }
  />
);

export const ThermometerIcon = (p: IconProps) => (
  <Icon {...p} d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />
);

export const ZapIcon = (p: IconProps) => <Icon {...p} d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />;

export const ChevronDownIcon = (p: IconProps) => <Icon {...p} d="m6 9 6 6 6-6" />;

export const ExternalLinkIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <path d="M10 14 21 3" />
      </>
    }
  />
);

export const RadioIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <circle cx="12" cy="12" r="2" />
        <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
      </>
    }
  />
);

export const ShieldCheckIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </>
    }
  />
);

export const ContainerIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z" />
        <path d="M10 21.9V14L2.1 9.1" />
        <path d="m10 14 11.9-6.9" />
        <path d="M14 19.8v-8.1" />
        <path d="M18 17.5V9.4" />
      </>
    }
  />
);

export const LoopbackIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="m17 2 4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </>
    }
  />
);

export const SettingsIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </>
    }
  />
);

export const AlertTriangleIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    }
  />
);

export const RefreshIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        <path d="M3 21v-5h5" />
      </>
    }
  />
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p} d="M5 3l14 9-14 9V3z" />
);

export const StopIcon = (p: IconProps) => (
  <Icon {...p} d="M6 6h12v12H6z" />
);

export const TrashIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <line x1="10" y1="11" x2="10" y2="17" />
        <line x1="14" y1="11" x2="14" y2="17" />
      </>
    }
  />
);

export const FileTextIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <line x1="10" y1="9" x2="8" y2="9" />
      </>
    }
  />
);

export const InfoIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </>
    }
  />
);

export const UsersIcon = (p: IconProps) => (
  <Icon
    {...p}
    paths={
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    }
  />
);
