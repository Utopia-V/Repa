// Adapted from shadcn/ui new-york-v4 (MIT); see README.md.
"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { PanelLeftIcon } from "lucide-react"
import { Slot } from "radix-ui"

import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"


// 侧栏宽度属于布局尺寸，不占用 spacing token；默认 280px，可拖动范围 200–480px。
const SIDEBAR_WIDTH_DEFAULT = 280
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 480
const SIDEBAR_WIDTH_MOBILE = "min(320px, calc(100vw - 48px))"
const SIDEBAR_WIDTH_ICON = "calc(var(--button-md-height) + var(--space-16))"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"
// 把手拖动阈值（px）与双击窗口（ms）。
const SIDEBAR_RESIZE_THRESHOLD = 4
const SIDEBAR_RAIL_DOUBLE_CLICK_MS = 250

/** 视口允许的最大宽度：不超过 480px，也不超过 40vw。 */
const sidebarWidthMaxNow = () => Math.min(SIDEBAR_WIDTH_MAX, window.innerWidth * 0.4)

/** 收敛到允许范围内并取整，避免状态里出现小数宽度。 */
const clampSidebarWidth = (value: number, max = SIDEBAR_WIDTH_MAX) =>
  Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, value)))

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  width: number
  setWidth: (value: number | ((prev: number) => number)) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)
  const [_width, _setWidth] = React.useState(SIDEBAR_WIDTH_DEFAULT)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  // 拖动改宽的提交入口；始终收敛到允许范围内。
  const setWidth = React.useCallback(
    (value: number | ((prev: number) => number)) => {
      _setWidth((prev) => clampSidebarWidth(typeof value === "function" ? value(prev) : value, sidebarWidthMaxNow()))
    },
    []
  )

  React.useEffect(() => {
    if (!isMobile) setOpenMobile(false)
  }, [isMobile])

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

    },
    [setOpenProp, open]
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.repeat &&
        !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) &&
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      width: _width,
      setWidth,
      triggerRef,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar, _width, setWidth]
  )

  return (
    <SidebarContext.Provider value={contextValue}>

        <div
          data-slot="sidebar-wrapper"
          style={
            {
              "--sidebar-width": `min(${_width}px, 40vw)`,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            "group/sidebar-wrapper flex min-h-dvh w-full has-data-[variant=inset]:bg-card",
            className
          )}
          {...props}
        >
          {children}
        </div>

    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
}) {
  const { isMobile, state, openMobile, setOpenMobile, triggerRef } = useSidebar()

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          "flex h-full w-(--sidebar-width) flex-col bg-card text-card-foreground",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="w-(--sidebar-width) bg-card p-0 text-card-foreground"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            if (triggerRef.current?.isConnected) {
              event.preventDefault()
              triggerRef.current.focus()
            }
          }}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>工作台导航</SheetTitle>
            <SheetDescription>切换功能或浏览会话。</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden text-card-foreground md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-300 ease-linear",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
        )}
      />
      <div
        data-slot="sidebar-container"
        inert={state === "collapsed" && collapsible === "offcanvas"}
        className={cn(
          "fixed inset-y-0 z-10 hidden h-dvh w-(--sidebar-width) transition-[left,right,width] duration-300 ease-linear md:flex",
          side === "left"
            ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
            : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-card group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-border group-data-[variant=floating]:shadow-sm"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar, isMobile, openMobile, open, triggerRef } = useSidebar()

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={className}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (isMobile && !openMobile) triggerRef.current = event.currentTarget
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon />
      <span className="sr-only">{(isMobile ? openMobile : open) ? "收起导航" : "打开导航"}</span>
    </Button>
  )
}

type SidebarRailDrag = {
  pointerId: number
  startX: number
  startWidth: number
  direction: number
  wrapper: HTMLElement
  bodyCursor: string
  bodyUserSelect: string
  moved: boolean
  ended: boolean
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar, open, setOpen, width, setWidth } = useSidebar()
  const dragRef = React.useRef<SidebarRailDrag | null>(null)
  const suppressClickRef = React.useRef(false)
  const clickTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const finishDrag = React.useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    suppressClickRef.current = drag.moved
    delete drag.wrapper.dataset.resizing
    document.body.style.cursor = drag.bodyCursor
    document.body.style.userSelect = drag.bodyUserSelect
    dragRef.current = null
  }, [])

  React.useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    finishDrag()
  }, [finishDrag])

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragRef.current) return
    const wrapper = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')
    const root = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar"]')
    const container = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar-container"]')
    if (!wrapper || !container) return
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    suppressClickRef.current = false
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: container.getBoundingClientRect().width,
      direction: root?.dataset.side === "right" ? -1 : 1,
      wrapper,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
      moved: false,
      ended: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.ended || event.pointerId !== drag.pointerId) return
    const delta = (event.clientX - drag.startX) * drag.direction
    if (!drag.moved) {
      if (Math.abs(delta) < SIDEBAR_RESIZE_THRESHOLD) return
      drag.moved = true
      drag.wrapper.dataset.resizing = "true"
      document.body.style.cursor = "ew-resize"
      document.body.style.userSelect = "none"
    }
    const target = drag.startWidth + delta
    if (open && drag.startWidth >= SIDEBAR_WIDTH_MIN && target < SIDEBAR_WIDTH_MIN) {
      // 收起是状态切换，恢复完整过渡，不能沿用拖动时的短过渡。
      delete drag.wrapper.dataset.resizing
      setOpen(false)
      drag.ended = true
    } else if (open) {
      setWidth(target)
    } else if (target >= SIDEBAR_WIDTH_MIN) {
      // 折叠栏的小幅拖动不展开；越过阈值后完整播放展开过渡。
      delete drag.wrapper.dataset.resizing
      setWidth(target)
      setOpen(true)
      drag.ended = true
    }
  }

  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (event.detail === 0) {
      toggleSidebar()
    } else if (event.detail === 2) {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      setWidth(SIDEBAR_WIDTH_DEFAULT)
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        toggleSidebar()
      }, SIDEBAR_RAIL_DOUBLE_CLICK_MS)
    }
  }

  return (
    <button
      {...props}
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="切换侧栏"
      title="拖动调整宽度，点击切换，双击重置；方向键调整宽度"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onKeyDown={(event) => {
        const direction = event.currentTarget.closest('[data-side]')?.getAttribute("data-side") === "right" ? -1 : 1
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault()
          setWidth(width + (event.key === "ArrowRight" ? 16 : -16) * direction)
        } else if (event.key === "Home") {
          event.preventDefault()
          setWidth(SIDEBAR_WIDTH_DEFAULT)
        }
      }}
      className={cn(
        "absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-border md:flex cursor-ew-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-card",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
    />
  )
}


function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn(
        "flex shrink-0 flex-col gap-3 p-4 transition-[padding,gap] duration-300 ease-linear group-data-[collapsible=icon]:gap-2 group-data-[collapsible=icon]:p-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn(
        "flex shrink-0 flex-col gap-3 p-4 transition-[padding,gap] duration-300 ease-linear group-data-[collapsible=icon]:gap-2 group-data-[collapsible=icon]:p-2",
        className
      )}
      {...props}
    />
  )
}


function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn(
        "relative flex w-full min-w-0 flex-col px-4 py-1 transition-[padding] duration-300 ease-linear group-data-[collapsible=icon]:px-2",
        className
      )}
      {...props}
    />
  )
}




function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-md px-4 py-2 text-left text-sm font-medium text-muted-foreground [font-family:var(--font-heading)] no-underline outline-none transition-[width,height,padding,color,background-color,border-color] duration-300 ease-linear hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring active:bg-accent disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-accent data-[active=true]:font-bold data-[active=true]:text-accent-foreground aria-[current=page]:bg-accent aria-[current=page]:font-bold aria-[current=page]:text-accent-foreground [&>span]:min-w-0 [&>span]:truncate [&>svg]:size-5 [&>svg]:shrink-0 group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border group-data-[collapsible=icon]:border-solid group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:data-[active=true]:border-border-selected group-data-[collapsible=icon]:aria-[current=page]:border-border-selected",
  {
    variants: {
      variant: { default: "" },
      size: { default: "min-h-[max(var(--button-md-height),var(--hit-size))]" },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : "button"

  const button = (
    <Comp
      {...(!asChild ? { type: "button" as const } : {})}
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  return button
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "mt-1 mr-0 mb-2 ml-6 flex min-w-0 list-none flex-col gap-1 p-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  )
}

function SidebarMenuSubButton({
  asChild = false,
  isActive = false,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean
  isActive?: boolean
}) {
  const Comp = asChild ? Slot.Root : "a"

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-active={isActive}
      className={cn(
        sidebarMenuButtonVariants(),
        "min-w-0",
        className
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
}
