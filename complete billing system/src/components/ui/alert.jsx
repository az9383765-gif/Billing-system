import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from './utils.js';

// ShadCN-style alert over the .alert banners.
export const alertVariants = cva('alert', {
  variants: {
    variant: {
      info: 'info',
      warn: 'warn',
      error: 'error',
      // no dedicated success banner in the design system — info reads positive
      success: 'info'
    }
  },
  defaultVariants: { variant: 'info' }
});

export const Alert = React.forwardRef(function Alert({ className, variant, ...props }, ref) {
  return <div ref={ref} className={cn(alertVariants({ variant }), className)} {...props} />;
});
