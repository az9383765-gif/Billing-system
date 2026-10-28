import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from './utils.js';

// The design system's button, expressed as ShadCN-style variants. Each variant
// maps onto the battle-tested .btn classes, so every screen — and every test —
// sees exactly the same DOM as a hand-written button.
//
// Unlike stock ShadCN, no default type is forced: several legacy <form>s rely
// on the browser's implicit submit button, and a plain <button> keeps that.
export const buttonVariants = cva('btn', {
  variants: {
    variant: {
      default: '',
      secondary: 'secondary',
      success: 'success',
      danger: 'danger',
      ghost: 'ghost',
      outline: 'secondary'
    },
    size: {
      default: '',
      sm: 'sm',
      xs: 'xs',
      icon: 'icon-btn'
    }
  },
  defaultVariants: { variant: 'default', size: 'default' }
});

export const Button = React.forwardRef(function Button(
  { className, variant, size, ...props },
  ref
) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
