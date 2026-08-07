import { forwardRef } from 'react';

const VARIANTS = {
  primary: 'bg-brass hover:bg-brassbright text-ink font-semibold',
  secondary: 'border border-brass/50 text-brassbright hover:bg-panelup',
  ghost: 'text-brass hover:text-brassbright',
  destructive: 'text-ash hover:text-oxblood',
  // Neutral "Cancel" affordance used in both modals — not brand-colored,
  // just a lower-emphasis dismissal.
  neutral: 'text-ash hover:text-bone',
};

const SIZES = {
  sm: 'px-4 py-2 text-sm',
  md: 'px-6 py-2.5',
  lg: 'px-8 py-3.5',
  // Escape hatch for the handful of one-off paddings (e.g. px-3 py-2, px-5
  // py-2) that don't cleanly fit the scale above — pass padding via className.
  none: '',
};

// Covers the four button treatments already in use across the site (see the
// bg-brass/border-brass/text-brass/text-ash "hover:text-oxblood" strings this
// replaces). `as` lets it render as a react-router Link where one was used in
// place of a <button>.
const Button = forwardRef(function Button(
  { as: Comp = 'button', variant = 'primary', size = 'md', icon, className = '', children, ...rest },
  ref
) {
  return (
    <Comp
      ref={ref}
      className={`inline-flex items-center gap-2 rounded-lg transition-colors disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </Comp>
  );
});

export default Button;
