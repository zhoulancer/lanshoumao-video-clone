import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/35 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[#2563EB] text-white shadow-sm hover:bg-[#1D4ED8] hover:shadow-md",
        destructive:
          "bg-[#DC2626] text-white shadow-sm hover:bg-[#A83A30]",
        outline:
          "border border-[#C2CDDD] bg-transparent shadow-sm text-[#55637A] hover:bg-[#F3F7FD] hover:text-[#0E1726] hover:border-[#0E1726]",
        secondary:
          "bg-[#D8E1EE] text-[#0E1726] shadow-sm hover:bg-[#C2CDDD]",
        ghost: "text-[#55637A] hover:bg-[#D8E1EE]/50 hover:text-[#0E1726]",
        link: "text-[#2563EB] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-12 rounded-xl px-8 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
