import { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format, addHours } from "date-fns";
import {
  Map as MapIcon, Crosshair, Wind, Navigation, Activity, Clock,
  Layers, Rocket, Settings2, Play, Pause, Video, Target, MapPin,
  ChevronRight, CheckCircle2, AlertCircle, ArrowRight, Zap, Globe
} from "lucide-react";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ReferenceLine
} from "recharts";

import { useRunSimulation, useGetPresets, getGetPresetsQueryKey, usePlanFlight } from "@workspace/api-client-react";
import type { SimulationInput, SimulationResult, FlightCase, PlanResult, RecommendedWindow } from "@workspace/api-client-react";

import { BalloonMap } from "@/components/Map";
import BalloonCamera from "@/components/BalloonCamera";
import Route3D from "@/components/Route3D";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const BALLOON_SIZES = [
  { value: "100",  label: "100g  (소형, ~4.5m burst)" },
  { value: "200",  label: "200g  (소형, ~5.5m burst)" },
  { value: "300",  label: "300g  (소형, ~6.2m burst)" },
  { value: "600",  label: "600g  (중형, ~7.5m burst)" },
  { value: "800",  label: "800g  (중형, ~8.3m burst)" },
  { value: "1000", label: "1000g (표준, ~9.0m burst)" },
  { value: "1200", label: "1200g (대형, ~9.7m burst)" },
  { value: "1500", label: "1500g (대형, ~10.2m burst)" },
  { value: "2000", label: "2000g (초대형, ~11.3m burst)" },
  { value: "3000", label: "3000g (특대, ~13.0m burst)" },
];

const PARACHUTE_TYPES = [
  { value: "cross",         label: "십자형 (Cross/Cruciform)", cd: 0.97 },
  { value: "octagonal",     label: "팔각형 (Octagonal)",       cd: 0.85 },
  { value: "hemispheric",   label: "반구형 (Hemispheric)",     cd: 0.75 },
  { value: "flat_circular", label: "평면원형 (Flat Circular)", cd: 0.75 },
];

const CASE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b"] as const;
const CASE_BG     = ["bg-green-500/10", "bg-blue-500/10", "bg-amber-500/10"] as const;
const CASE_BORDER = ["border-green-500/30", "border-blue-500/30", "border-amber-500/30"] as const;
const CASE_TEXT   = ["text-green-400", "text-blue-400", "text-amber-400"] as const;

// Sea-level physics preview (no server round-trip)
const RHO_AIR_SL = 1.225;
const RHO_HE_SL  = 101325 / (2077 * 288.15);
const G_CONST    = 9.80665;
const C_D_BALL   = 0.47;

function previewAscentRate(heVol: number, balloonG: number, payloadG: number): number | null {
  if (!heVol || !balloonG) return null;
  const m = (balloonG + payloadG) / 1000;
  const r = Math.cbrt(3 * heVol / (4 * Math.PI));
  const net = (RHO_AIR_SL - RHO_HE_SL) * heVol * G_CONST - m * G_CONST;
  if (net <= 0) return 0;
  return Math.sqrt(net / (0.5 * C_D_BALL * RHO_AIR_SL * Math.PI * r * r));
}

function previewDescentRate(diameter: number, cd: number, balloonG: number, payloadG: number): number | null {
  if (!diameter || !cd || !balloonG) return null;
  const m = (balloonG + payloadG) / 1000;
  const A = Math.PI * (diameter / 2) ** 2;
  return Math.sqrt(2 * m * G_CONST / (cd * RHO_AIR_SL * A));
}

const formSchema = z.object({
  latitude:             z.coerce.number().min(-90).max(90),
  longitude:            z.coerce.number().min(-180).max(180),
  launch_datetime:      z.string().min(1, "Launch datetime is required"),
  balloon_mass_g:       z.coerce.number().min(50).max(3000),
  payload_mass_g:       z.coerce.number().min(0).max(10000),
  helium_volume_m3:     z.coerce.number().min(0.1).max(500),
  parachute_diameter_m: z.coerce.number().min(0.2).max(10),
  parachute_cd:         z.coerce.number().min(0.3).max(1.5),
  time_step:            z.coerce.number().min(1).max(300).default(60),
});

const planFormSchema = z.object({
  launch_lat:      z.coerce.number().min(-90).max(90),
  launch_lng:      z.coerce.number().min(-180).max(180),
  target_lat:      z.coerce.number().min(-90).max(90),
  target_lng:      z.coerce.number().min(-180).max(180),
  payload_mass_g:  z.coerce.number().min(0).max(10000),
  launch_datetime: z.string().min(1),
});

export default function Home() {
  const [mode, setMode] = useState<"simulate" | "plan">("simulate");

  // ── Simulation mode state ────────────────────────────────────────────────
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [animFrame, setAnimFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [videoViewOpen, setVideoViewOpen] = useState(false);
  const [globeViewOpen, setGlobeViewOpen] = useState(false);

  // ── Planning mode state ──────────────────────────────────────────────────
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [selectedCaseIdx, setSelectedCaseIdx] = useState<number | null>(null);
  const [mapClickMode, setMapClickMode] = useState<"launch" | "target" | null>(null);

  const { data: presets } = useGetPresets({
    query: { queryKey: getGetPresetsQueryKey() }
  });

  const runSim = useRunSimulation();
  const planSim = usePlanFlight();

  const [parachuteType, setParachuteType] = useState("cross");

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      latitude:             37.5665,
      longitude:            126.9780,
      launch_datetime:      format(addHours(new Date(), 1), "yyyy-MM-dd'T'HH:mm"),
      balloon_mass_g:       1000,
      payload_mass_g:       500,
      helium_volume_m3:     4.0,
      parachute_diameter_m: 1.5,
      parachute_cd:         0.97,
      time_step:            60,
    },
  });

  const planForm = useForm<z.infer<typeof planFormSchema>>({
    resolver: zodResolver(planFormSchema),
    defaultValues: {
      launch_lat:      37.5665,
      launch_lng:      126.9780,
      target_lat:      37.0,
      target_lng:      127.5,
      payload_mass_g:  500,
      launch_datetime: format(addHours(new Date(), 1), "yyyy-MM-dd'T'HH:mm"),
    },
  });

  // Live preview
  const watchHelium   = form.watch("helium_volume_m3");
  const watchBalloon  = form.watch("balloon_mass_g");
  const watchPayload  = form.watch("payload_mass_g");
  const watchParaDiam = form.watch("parachute_diameter_m");
  const watchParaCd   = form.watch("parachute_cd");

  const liveAscentRate  = useMemo(
    () => previewAscentRate(watchHelium, watchBalloon, watchPayload ?? 0),
    [watchHelium, watchBalloon, watchPayload]
  );
  const liveDescentRate = useMemo(
    () => previewDescentRate(watchParaDiam, watchParaCd, watchBalloon, watchPayload ?? 0),
    [watchParaDiam, watchParaCd, watchBalloon, watchPayload]
  );

  const handleRunSimulation = (values: z.infer<typeof formSchema>) => {
    const date = new Date(values.launch_datetime);
    runSim.mutate(
      { data: { ...values, launch_datetime: date.toISOString() } },
      {
        onSuccess: (data) => {
          setResult(data);
          setAnimFrame(0);
          setIsPlaying(false);
        }
      }
    );
  };

  const handleRunPlan = (values: z.infer<typeof planFormSchema>) => {
    const date = new Date(values.launch_datetime);
    planSim.mutate(
      {
        launch_lat:      values.launch_lat,
        launch_lng:      values.launch_lng,
        target_lat:      values.target_lat,
        target_lng:      values.target_lng,
        payload_mass_g:  values.payload_mass_g,
        launch_datetime: date.toISOString(),
      },
      {
        onSuccess: (data) => {
          setPlanResult(data);
          setSelectedCaseIdx(null);
        }
      }
    );
  };

  const handleUseCaseForSimulation = (fc: FlightCase) => {
    const cd = fc.parachute_cd;
    const matchType = PARACHUTE_TYPES.find(t => Math.abs(t.cd - cd) < 0.01);
    if (matchType) setParachuteType(matchType.value);
    form.reset({
      latitude:             planForm.getValues("launch_lat"),
      longitude:            planForm.getValues("launch_lng"),
      launch_datetime:      planForm.getValues("launch_datetime"),
      balloon_mass_g:       fc.balloon_mass_g,
      payload_mass_g:       planForm.getValues("payload_mass_g"),
      helium_volume_m3:     fc.helium_volume_m3,
      parachute_diameter_m: fc.parachute_diameter_m,
      parachute_cd:         fc.parachute_cd,
      time_step:            60,
    });
    setResult(fc.simulation);
    setAnimFrame(0);
    setIsPlaying(false);
    setMode("simulate");
  };

  const loadPreset = (presetId: string) => {
    const preset = presets?.find(p => p.id === presetId);
    if (preset) {
      const cd = preset.config.parachute_cd;
      const match = PARACHUTE_TYPES.find(t => Math.abs(t.cd - cd) < 0.01);
      if (match) setParachuteType(match.value);
      form.reset({
        ...preset.config,
        launch_datetime: format(new Date(preset.config.launch_datetime), "yyyy-MM-dd'T'HH:mm")
      });
    }
  };

  const currentLat = form.watch("latitude");
  const currentLng = form.watch("longitude");
  const planLaunchLat = planForm.watch("launch_lat");
  const planLaunchLng = planForm.watch("launch_lng");
  const planTargetLat = planForm.watch("target_lat");
  const planTargetLng = planForm.watch("target_lng");

  // Handle map click for planning mode
  const handleMapClick = (lat: number, lng: number) => {
    if (mapClickMode === "launch") {
      planForm.setValue("launch_lat", Math.round(lat * 10000) / 10000);
      planForm.setValue("launch_lng", Math.round(lng * 10000) / 10000);
      setMapClickMode(null);
    } else if (mapClickMode === "target") {
      planForm.setValue("target_lat", Math.round(lat * 10000) / 10000);
      planForm.setValue("target_lng", Math.round(lng * 10000) / 10000);
      setMapClickMode(null);
    }
  };

  // Playback effect
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isPlaying && result?.trajectory) {
      interval = setInterval(() => {
        setAnimFrame(prev => {
          if (prev >= result.trajectory.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 100 / playSpeed);
    }
    return () => clearInterval(interval);
  }, [isPlaying, playSpeed, result]);

  // Chart data prep
  const chartData = result?.trajectory.map(pt => {
    const timeMins = (new Date(pt.time).getTime() - new Date(result.trajectory[0].time).getTime()) / 60000;
    return {
      ...pt,
      timeMins,
      ascentAlt: pt.phase === "ascent" ? pt.altitude : null,
      descentAlt: pt.phase === "descent" ? pt.altitude : null,
      abs_vertical_speed: Math.abs(pt.vertical_speed)
    };
  });
  
  const burstPointMin = chartData?.find(d => d.phase === "descent")?.timeMins || 0;

  // Map props computation
  const mapLaunchPos = mode === "plan"
    ? { lat: planLaunchLat || 37.5665, lng: planLaunchLng || 126.978 }
    : { lat: currentLat || 37.5665, lng: currentLng || 126.978 };

  const mapTargetPos = mode === "plan" && planTargetLat && planTargetLng
    ? { lat: planTargetLat, lng: planTargetLng }
    : null;

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-sans selection:bg-primary/30">
      
      {/* Left Sidebar */}
      <div className="w-[480px] min-w-[480px] h-full flex flex-col border-r border-border bg-card/50 backdrop-blur shadow-2xl relative z-10">
        
        {/* Header */}
        <div className="px-6 py-5 border-b border-border bg-card">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50 text-primary">
              <Rocket className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight uppercase text-foreground">Fall Prediction Simulator</h1>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">Flight Planning Tool v2.0</p>
            </div>
          </div>
          <Tabs value={mode} onValueChange={(v) => setMode(v as "simulate" | "plan")} className="w-full">
            <TabsList className="w-full h-9 bg-muted/50 border border-border">
              <TabsTrigger value="simulate" className="flex-1 text-xs font-mono uppercase tracking-wider">
                <Activity className="w-3.5 h-3.5 mr-1.5" />
                시뮬레이션
              </TabsTrigger>
              <TabsTrigger value="plan" className="flex-1 text-xs font-mono uppercase tracking-wider">
                <Target className="w-3.5 h-3.5 mr-1.5" />
                역방향 계획
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <ScrollArea className="flex-1">
          {/* ══════════════════════════════════════════════════════════════════
              SIMULATION MODE
          ══════════════════════════════════════════════════════════════════ */}
          {mode === "simulate" && (
            <div className="p-6 space-y-8">
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                    <Settings2 className="w-3.5 h-3.5" />
                    Parameters
                  </h2>
                  
                  {presets && presets.length > 0 && (
                    <Select onValueChange={loadPreset}>
                      <SelectTrigger className="h-7 w-[140px] text-xs font-mono bg-muted/50 border-border">
                        <SelectValue placeholder="Load Preset..." />
                      </SelectTrigger>
                      <SelectContent>
                        {presets.map(p => (
                          <SelectItem key={p.id} value={p.id} className="text-xs font-mono">{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <Form {...form}>
                  <form onSubmit={form.handleSubmit(handleRunSimulation)} className="space-y-5">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="latitude"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-mono text-muted-foreground">LATITUDE</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.0001" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="longitude"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-mono text-muted-foreground">LONGITUDE</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.0001" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="launch_datetime"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">LAUNCH DATETIME (LOCAL)</FormLabel>
                          <FormControl>
                            <Input type="datetime-local" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="helium_volume_m3"
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center justify-between">
                            <FormLabel className="text-xs font-mono text-muted-foreground">HELIUM VOLUME (m³)</FormLabel>
                            {liveAscentRate !== null && (
                              <span className={`text-[10px] font-mono font-bold ${liveAscentRate < 1 ? "text-red-400" : "text-cyan-400"}`}>
                                {liveAscentRate < 0.5 ? "부력 부족" : `~${liveAscentRate.toFixed(1)} m/s 상승`}
                              </span>
                            )}
                          </div>
                          <FormControl>
                            <Input type="number" step="0.1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="balloon_mass_g"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">BALLOON SIZE</FormLabel>
                          <Select
                            value={String(field.value)}
                            onValueChange={(v) => field.onChange(Number(v))}
                          >
                            <FormControl>
                              <SelectTrigger className="font-mono text-xs h-9 bg-muted/30 border-border">
                                <SelectValue placeholder="Select balloon..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {BALLOON_SIZES.map(s => (
                                <SelectItem key={s.value} value={s.value} className="font-mono text-xs">
                                  {s.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />

                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="payload_mass_g"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-mono text-muted-foreground">PAYLOAD (g)</FormLabel>
                            <FormControl>
                              <Input type="number" step="10" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="time_step"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-mono text-muted-foreground">TIME STEP (s)</FormLabel>
                            <FormControl>
                              <Input type="number" step="1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="pt-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                        <Wind className="w-3 h-3" /> Parachute
                      </p>
                      <div className="space-y-3">
                        <div>
                          <label className="text-xs font-mono text-muted-foreground block mb-1.5">CANOPY TYPE</label>
                          <Select
                            value={parachuteType}
                            onValueChange={(v) => {
                              setParachuteType(v);
                              const t = PARACHUTE_TYPES.find(pt => pt.value === v);
                              if (t) form.setValue("parachute_cd", t.cd);
                            }}
                          >
                            <SelectTrigger className="font-mono text-xs h-9 bg-muted/30 border-border w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PARACHUTE_TYPES.map(t => (
                                <SelectItem key={t.value} value={t.value} className="font-mono text-xs">
                                  {t.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <FormField
                            control={form.control}
                            name="parachute_diameter_m"
                            render={({ field }) => (
                              <FormItem>
                                <div className="flex items-center justify-between mb-1.5">
                                  <FormLabel className="text-xs font-mono text-muted-foreground">DIAMETER (m)</FormLabel>
                                  {liveDescentRate !== null && (
                                    <span className="text-[10px] font-mono text-orange-400">
                                      ~{liveDescentRate.toFixed(1)} m/s
                                    </span>
                                  )}
                                </div>
                                <FormControl>
                                  <Input type="number" step="0.1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                                </FormControl>
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="parachute_cd"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-mono text-muted-foreground">DRAG COEFF C_D</FormLabel>
                                <FormControl>
                                  <Input type="number" step="0.01" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                                </FormControl>
                              </FormItem>
                            )}
                          />
                        </div>
                      </div>
                    </div>

                    <Button 
                      type="submit" 
                      className="w-full h-10 font-bold tracking-wider uppercase text-xs" 
                      disabled={runSim.isPending}
                    >
                      {runSim.isPending ? "Calculating Trajectory..." : "Run Simulation"}
                    </Button>
                  </form>
                </Form>
              </div>

              <Separator className="bg-border/50" />

              {/* Results & Animation Controls */}
              {result && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                      <Activity className="w-3.5 h-3.5" />
                      Flight Telemetry
                    </h2>
                    <Badge variant="outline" className="font-mono text-[10px] bg-primary/10 text-primary border-primary/20">
                      T+{Math.floor(result.stats.total_duration_seconds / 60)}m
                    </Badge>
                  </div>

                  {/* Animation Controls */}
                  <div className="p-4 bg-black/40 border border-border rounded-lg space-y-4">
                    <div className="flex items-center justify-between gap-4">
                      <Button 
                        variant="outline" 
                        size="icon" 
                        onClick={() => setIsPlaying(!isPlaying)}
                        className="h-8 w-8 bg-muted/50"
                      >
                        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </Button>
                      
                      <div className="flex-1 flex items-center gap-3">
                        <Slider
                          value={[animFrame]}
                          min={0}
                          max={result.trajectory.length - 1}
                          step={1}
                          onValueChange={(vals) => setAnimFrame(vals[0])}
                          className="flex-1"
                        />
                        <span className="text-xs font-mono text-muted-foreground w-12 text-right">
                          {Math.floor((animFrame / (result.trajectory.length - 1)) * 100)}%
                        </span>
                      </div>

                      <Select value={playSpeed.toString()} onValueChange={(v) => setPlaySpeed(parseInt(v))}>
                        <SelectTrigger className="w-[70px] h-8 text-xs font-mono">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1x</SelectItem>
                          <SelectItem value="5">5x</SelectItem>
                          <SelectItem value="10">10x</SelectItem>
                          <SelectItem value="20">20x</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Alt:</span>
                        <span className="font-bold text-foreground">{result.trajectory[animFrame].altitude.toFixed(0)}m</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Wind:</span>
                        <span className="text-yellow-500">{result.trajectory[animFrame].wind_speed.toFixed(1)}m/s</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">V.Speed:</span>
                        <span className={result.trajectory[animFrame].vertical_speed >= 0 ? "text-green-500" : "text-red-500"}>
                          {result.trajectory[animFrame].vertical_speed > 0 ? "+" : ""}{result.trajectory[animFrame].vertical_speed.toFixed(1)}m/s
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">H.Speed:</span>
                        <span className="text-cyan-500">{result.trajectory[animFrame].horizontal_speed.toFixed(1)}m/s</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Phase:</span>
                        <span className={result.trajectory[animFrame].phase === "ascent" ? "text-cyan-500" : "text-orange-500"}>
                          {result.trajectory[animFrame].phase.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Press:</span>
                        <span>{result.trajectory[animFrame].pressure_hpa.toFixed(1)}hPa</span>
                      </div>
                    </div>
                  </div>

                  {/* Balloon Config Panel */}
                  {result.balloon_config && (
                    <div className="p-4 rounded-lg border border-primary/20 bg-primary/5 space-y-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-primary/70">
                        Balloon Configuration (Calculated)
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
                        <div className="flex justify-between col-span-2 border-b border-primary/10 pb-2">
                          <span className="text-muted-foreground">Burst Altitude</span>
                          <span className="font-bold text-primary text-sm">
                            {(result.balloon_config.burst_altitude_m / 1000).toFixed(1)} km
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Ascent Rate</span>
                          <span className="text-cyan-400">{result.balloon_config.ascent_rate_ms.toFixed(1)} m/s</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Descent (SL)</span>
                          <span className="text-orange-400">{result.balloon_config.descent_rate_sl_ms.toFixed(1)} m/s</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Fill Ø</span>
                          <span>{result.balloon_config.fill_diameter_m.toFixed(2)} m</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Burst Ø</span>
                          <span>{result.balloon_config.burst_diameter_m.toFixed(1)} m</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Fill Vol.</span>
                          <span>{result.balloon_config.volume_fill_m3.toFixed(2)} m³</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Neck Lift</span>
                          <span>{result.balloon_config.neck_lift_n.toFixed(1)} N</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <StatCard 
                      label="Flight Time" 
                      value={`${Math.floor(result.stats.total_duration_seconds / 3600)}h ${Math.floor((result.stats.total_duration_seconds % 3600) / 60)}m`}
                      icon={<Clock className="w-3.5 h-3.5 text-muted-foreground" />}
                    />
                    <StatCard 
                      label="Max Altitude" 
                      value={`${(result.stats.max_altitude / 1000).toFixed(1)} km`}
                      icon={<Layers className="w-3.5 h-3.5 text-muted-foreground" />}
                    />
                    <StatCard 
                      label="Peak Wind" 
                      value={`${result.stats.max_wind_speed.toFixed(1)} m/s`}
                      icon={<Wind className="w-3.5 h-3.5 text-muted-foreground" />}
                    />
                    <StatCard 
                      label="Horiz. Drift" 
                      value={`${result.stats.horizontal_drift_km.toFixed(1)} km`}
                      icon={<Navigation className="w-3.5 h-3.5 text-muted-foreground" />}
                    />
                  </div>

                  {/* Charts */}
                  {chartData && (
                    <Collapsible className="w-full border border-border rounded-lg bg-black/20">
                      <CollapsibleTrigger className="flex w-full items-center justify-between p-4 text-xs font-bold uppercase tracking-wider hover:bg-muted/30">
                        FLIGHT CHARTS
                      </CollapsibleTrigger>
                      <CollapsibleContent className="p-4 pt-0 space-y-6">
                        <div className="space-y-2">
                          <div className="text-[10px] font-mono text-muted-foreground text-center">Altitude Profile</div>
                          <div className="h-[220px]">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                <XAxis dataKey="timeMins" tick={{fontSize: 10}} stroke="#666" />
                                <YAxis tick={{fontSize: 10}} stroke="#666" />
                                <RechartsTooltip contentStyle={{backgroundColor: '#111', border: '1px solid #333', fontSize: '12px'}} />
                                <ReferenceLine x={burstPointMin} stroke="#eab308" strokeDasharray="3 3" />
                                <Line type="monotone" dataKey="ascentAlt" stroke="#0ea5e9" strokeWidth={2} dot={false} isAnimationActive={false} />
                                <Line type="monotone" dataKey="descentAlt" stroke="#f97316" strokeWidth={2} dot={false} isAnimationActive={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="text-[10px] font-mono text-muted-foreground text-center">Speed Profile</div>
                          <div className="h-[220px]">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                <XAxis dataKey="timeMins" tick={{fontSize: 10}} stroke="#666" />
                                <YAxis tick={{fontSize: 10}} stroke="#666" />
                                <RechartsTooltip contentStyle={{backgroundColor: '#111', border: '1px solid #333', fontSize: '12px'}} />
                                <Legend wrapperStyle={{fontSize: '10px'}} />
                                <Line type="monotone" dataKey="total_speed" name="Total Speed" stroke="#fff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                <Line type="monotone" dataKey="horizontal_speed" name="Horizontal Speed" stroke="#0ea5e9" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                <Line type="monotone" dataKey="abs_vertical_speed" name="Vertical Speed (Abs)" stroke="#eab308" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )}

                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value="trajectory" className="border-border">
                      <AccordionTrigger className="text-xs font-mono text-muted-foreground hover:text-foreground py-3">
                        VIEW FULL TRAJECTORY LOG
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="bg-black/40 border border-border rounded-md overflow-hidden">
                          <table className="w-full text-[10px] font-mono text-left">
                            <thead className="bg-muted/50 text-muted-foreground border-b border-border">
                              <tr>
                                <th className="px-3 py-2 font-medium">Time (T+)</th>
                                <th className="px-3 py-2 font-medium">Alt (m)</th>
                                <th className="px-3 py-2 font-medium">Phase</th>
                                <th className="px-3 py-2 font-medium">Wind (m/s)</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/50">
                              {result.trajectory.filter((_, i) => i % 5 === 0 || i === result.trajectory.length - 1).map((pt, i) => {
                                const date = new Date(pt.time);
                                const launchDate = new Date(result.trajectory[0].time);
                                const tPlus = Math.floor((date.getTime() - launchDate.getTime()) / 60000);
                                return (
                                  <tr key={i} className="hover:bg-muted/30 transition-colors">
                                    <td className="px-3 py-2 text-muted-foreground">+{tPlus}m</td>
                                    <td className="px-3 py-2 text-foreground">{pt.altitude.toFixed(0)}</td>
                                    <td className="px-3 py-2">
                                      <span className={pt.phase === 'ascent' ? 'text-blue-400' : 'text-orange-400'}>
                                        {pt.phase.toUpperCase()}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-muted-foreground">{pt.wind_speed.toFixed(1)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              PLANNING MODE
          ══════════════════════════════════════════════════════════════════ */}
          {mode === "plan" && (
            <div className="p-6 space-y-6">
              <div className="space-y-1">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <Target className="w-3.5 h-3.5" />
                  역방향 비행 계획
                </h2>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  출발지와 목적지를 지도에서 클릭하고 탑재물 무게를 입력하면, 정확히 목적지에 도착하기 위한 최적 구성 3가지를 계산합니다.
                </p>
              </div>

              <Form {...planForm}>
                <form onSubmit={planForm.handleSubmit(handleRunPlan)} className="space-y-5">

                  {/* Launch Point */}
                  <div className="p-3 rounded-lg border border-border bg-muted/10 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-green-400 flex items-center gap-1.5">
                        <MapPin className="w-3 h-3" /> 출발지 (Launch)
                      </span>
                      <Button
                        type="button"
                        variant={mapClickMode === "launch" ? "default" : "outline"}
                        size="sm"
                        className="h-6 px-2 text-[10px] font-mono"
                        onClick={() => setMapClickMode(mapClickMode === "launch" ? null : "launch")}
                      >
                        {mapClickMode === "launch" ? "클릭 취소" : "지도에서 선택"}
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={planForm.control}
                        name="launch_lat"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-[10px] font-mono text-muted-foreground">LAT</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.0001" className="font-mono text-xs h-8 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={planForm.control}
                        name="launch_lng"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-[10px] font-mono text-muted-foreground">LNG</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.0001" className="font-mono text-xs h-8 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  {/* Target Point */}
                  <div className="p-3 rounded-lg border border-purple-500/30 bg-purple-500/5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
                        <Target className="w-3 h-3" /> 목적지 (Target)
                      </span>
                      <Button
                        type="button"
                        variant={mapClickMode === "target" ? "default" : "outline"}
                        size="sm"
                        className="h-6 px-2 text-[10px] font-mono"
                        onClick={() => setMapClickMode(mapClickMode === "target" ? null : "target")}
                      >
                        {mapClickMode === "target" ? "클릭 취소" : "지도에서 선택"}
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={planForm.control}
                        name="target_lat"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-[10px] font-mono text-muted-foreground">LAT</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.0001" className="font-mono text-xs h-8 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={planForm.control}
                        name="target_lng"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-[10px] font-mono text-muted-foreground">LNG</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.0001" className="font-mono text-xs h-8 bg-muted/30" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  {/* Payload & Datetime */}
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={planForm.control}
                      name="payload_mass_g"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">탑재물 무게 (g)</FormLabel>
                          <FormControl>
                            <Input type="number" step="10" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={planForm.control}
                      name="launch_datetime"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">발사 시각</FormLabel>
                          <FormControl>
                            <Input type="datetime-local" className="font-mono text-xs h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>

                  <Button
                    type="submit"
                    className="w-full h-10 font-bold tracking-wider uppercase text-xs"
                    disabled={planSim.isPending}
                  >
                    {planSim.isPending ? (
                      <span className="flex items-center gap-2">
                        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        최적 구성 탐색 중... (수십 초 소요)
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Zap className="w-4 h-4" />
                        최적 구성 계산 시작
                      </span>
                    )}
                  </Button>
                </form>
              </Form>

              {/* Error display */}
              {planSim.isError && (
                <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-red-400">{(planSim.error as any)?.message ?? "계획 계산 실패"}</p>
                </div>
              )}

              {/* Plan Results */}
              {planResult && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      최적 구성 결과
                    </h3>
                    <Badge variant="outline" className="font-mono text-[10px] bg-purple-500/10 text-purple-400 border-purple-500/20">
                      목적지까지 {planResult.launch_to_target_km.toFixed(1)} km
                    </Badge>
                  </div>

                  {/* Feasibility Banner */}
                  {planResult.feasibility_grade === "good" && (
                    <div className="p-3 rounded-lg border border-green-500/30 bg-green-500/10 flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-green-300">{planResult.feasibility_reason}</p>
                    </div>
                  )}
                  {planResult.feasibility_grade === "marginal" && (
                    <div className="p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-yellow-300">{planResult.feasibility_reason}</p>
                    </div>
                  )}
                  {planResult.feasibility_grade === "infeasible" && (
                    <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                      <div className="space-y-1">
                        <p className="text-xs font-bold text-red-400">이 날짜는 이론적으로 불가능합니다</p>
                        <p className="text-[10px] text-red-300/80">{planResult.feasibility_reason}</p>
                      </div>
                    </div>
                  )}

                  {/* Recommended Windows */}
                  {planResult.recommended_windows.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        향후 7일 추천 발사 시간대
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {planResult.recommended_windows.map((w, i) => {
                          const gradeColor = w.feasibility === "good"
                            ? "border-green-500/40 bg-green-500/10 text-green-300"
                            : w.feasibility === "marginal"
                            ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-300"
                            : "border-red-500/30 bg-red-500/5 text-red-400/70";
                          return (
                            <button
                              key={i}
                              type="button"
                              className={`rounded-lg border p-2 text-left hover:brightness-125 transition-all ${gradeColor}`}
                              onClick={() => {
                                const local = new Date(w.datetime);
                                const yyyy = local.getFullYear();
                                const mm = String(local.getMonth() + 1).padStart(2, "0");
                                const dd = String(local.getDate()).padStart(2, "0");
                                const hh = String(local.getHours()).padStart(2, "0");
                                const min = String(local.getMinutes()).padStart(2, "0");
                                planForm.setValue("launch_datetime", `${yyyy}-${mm}-${dd}T${hh}:${min}`);
                              }}
                            >
                              <div className="text-[10px] font-bold">{w.label}</div>
                              <div className="text-[9px] font-mono opacity-80">
                                {w.feasibility === "good" ? "✓ " : w.feasibility === "marginal" ? "△ " : "✗ "}
                                오차 {w.best_distance_km.toFixed(0)} km
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[9px] text-muted-foreground">클릭하면 해당 시간으로 변경됩니다. 이후 다시 계산하세요.</p>
                    </div>
                  )}

                  <div className="space-y-3">
                    {planResult.cases.map((fc, idx) => {
                      const color = CASE_COLORS[idx % CASE_COLORS.length];
                      const bgClass = CASE_BG[idx % CASE_BG.length];
                      const borderClass = CASE_BORDER[idx % CASE_BORDER.length];
                      const textClass = CASE_TEXT[idx % CASE_TEXT.length];
                      const isSelected = selectedCaseIdx === idx;

                      return (
                        <div
                          key={idx}
                          className={`rounded-lg border ${borderClass} ${bgClass} p-4 space-y-3 cursor-pointer transition-all ${isSelected ? "ring-2 ring-offset-1 ring-offset-background" : "hover:brightness-110"}`}
                          style={{ outlineColor: color, boxShadow: isSelected ? `0 0 0 2px ${color}` : undefined }}
                          onClick={() => setSelectedCaseIdx(isSelected ? null : idx)}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <div className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-black" style={{ backgroundColor: color }}>
                                  {idx + 1}
                                </div>
                                <span className={`text-xs font-bold ${textClass}`}>{fc.label}</span>
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-0.5 ml-6">{fc.description}</p>
                            </div>
                            <Badge
                              className="shrink-0 text-[10px] font-mono"
                              style={{ backgroundColor: `${color}20`, color, border: `1px solid ${color}40` }}
                            >
                              {fc.distance_to_target_km.toFixed(1)} km 오차
                            </Badge>
                          </div>

                          {/* Config details */}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px] font-mono ml-1">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">풍선:</span>
                              <span>{fc.balloon_mass_g}g</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">헬륨:</span>
                              <span className="text-cyan-400">{fc.helium_volume_m3.toFixed(1)} m³</span>
                            </div>
                            <div className="flex justify-between col-span-2">
                              <span className="text-muted-foreground">낙하산:</span>
                              <span>{fc.parachute_type} Ø{fc.parachute_diameter_m}m (Cd={fc.parachute_cd})</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">버스트 고도:</span>
                              <span className="text-yellow-400">{(fc.simulation.balloon_config.burst_altitude_m / 1000).toFixed(1)} km</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">비행 시간:</span>
                              <span>{Math.floor(fc.simulation.stats.total_duration_seconds / 60)}분</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">상승 속도:</span>
                              <span className="text-cyan-400">{fc.simulation.balloon_config.ascent_rate_ms.toFixed(1)} m/s</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">하강 속도:</span>
                              <span className="text-orange-400">{fc.simulation.balloon_config.descent_rate_sl_ms.toFixed(1)} m/s</span>
                            </div>
                            <div className="flex justify-between col-span-2 pt-1 border-t border-white/5">
                              <span className="text-muted-foreground">예상 착지점:</span>
                              <span>{fc.simulation.landing.latitude.toFixed(3)}°, {fc.simulation.landing.longitude.toFixed(3)}°</span>
                            </div>
                          </div>

                          <Button
                            size="sm"
                            className="w-full h-7 text-[10px] font-bold uppercase tracking-wider mt-1"
                            style={{ backgroundColor: `${color}30`, color, border: `1px solid ${color}50` }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUseCaseForSimulation(fc);
                            }}
                          >
                            <ArrowRight className="w-3 h-3 mr-1" />
                            이 구성으로 시뮬레이션 실행
                          </Button>
                        </div>
                      );
                    })}
                  </div>

                  <p className="text-[10px] text-muted-foreground text-center">
                    카드를 클릭하면 지도에서 경로가 강조됩니다 · 케이스를 선택해 상세 시뮬레이션을 실행하세요
                  </p>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right Side - Interactive Map */}
      <div className="flex-1 relative bg-black">
        <BalloonMap
          simulationResult={mode === "simulate" ? result : null}
          launchPos={mapLaunchPos}
          animFrame={mode === "simulate" && result ? animFrame : undefined}
          clickMode={mode === "plan" ? mapClickMode : null}
          targetPos={mode === "plan" ? mapTargetPos : null}
          onMapClick={mode === "plan" ? handleMapClick : undefined}
          planCases={mode === "plan" ? planResult?.cases : null}
          selectedCaseIdx={mode === "plan" ? selectedCaseIdx : null}
        />
        
        {/* Map Header Overlay */}
        <div className="absolute top-4 right-4 z-[400] flex gap-2">
          {mode === "simulate" && result && (
            <>
              <Button
                variant="secondary"
                className="bg-background/90 backdrop-blur shadow-lg border-border font-mono font-bold text-xs flex items-center gap-2"
                onClick={() => setGlobeViewOpen(true)}
              >
                <Globe className="w-4 h-4 text-cyan-400" />
                3D VIEW
              </Button>
              <Button 
                variant="secondary" 
                className="bg-background/90 backdrop-blur shadow-lg border-border font-mono font-bold text-xs flex items-center gap-2"
                onClick={() => setVideoViewOpen(true)}
              >
                <Video className="w-4 h-4" />
                VIDEO VIEW
              </Button>
            </>
          )}
        </div>

        {/* Map click hint overlay */}
        {mode === "plan" && mapClickMode && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[400] pointer-events-none">
            <div className="px-4 py-3 bg-background/90 backdrop-blur border border-primary/50 rounded-xl shadow-2xl text-sm font-mono text-center">
              <div className="w-8 h-8 border-2 border-primary rounded-full flex items-center justify-center mx-auto mb-2">
                <Crosshair className="w-4 h-4 text-primary" />
              </div>
              <p className="text-primary font-bold">
                {mapClickMode === "launch" ? "출발지를 클릭하세요" : "목적지를 클릭하세요"}
              </p>
            </div>
          </div>
        )}

        {/* Map UI overlays */}
        <div className="absolute bottom-6 right-6 z-[400] flex gap-2">
          {mode === "simulate" && result && (
            <div className="flex gap-4 px-4 py-2 bg-background/90 backdrop-blur border border-border rounded-full shadow-2xl items-center text-xs font-mono font-medium">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-sm bg-[#0ea5e9]"></div>
                <span className="text-muted-foreground">ASCENT</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-sm bg-[#f97316]"></div>
                <span className="text-muted-foreground">DESCENT</span>
              </div>
            </div>
          )}
          {mode === "plan" && planResult && (
            <div className="flex gap-3 px-4 py-2 bg-background/90 backdrop-blur border border-border rounded-full shadow-2xl items-center text-xs font-mono font-medium">
              {planResult.cases.map((fc, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: CASE_COLORS[idx % CASE_COLORS.length] }}></div>
                  <span className="text-muted-foreground">케이스 {idx + 1}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {videoViewOpen && result && mode === "simulate" && (
        <BalloonCamera 
          trajectory={result.trajectory}
          animFrame={animFrame}
          setAnimFrame={setAnimFrame}
          isPlaying={isPlaying}
          setIsPlaying={setIsPlaying}
          playSpeed={playSpeed}
          setPlaySpeed={setPlaySpeed}
          onClose={() => setVideoViewOpen(false)}
        />
      )}

      {globeViewOpen && result && mode === "simulate" && (
        <Route3D
          trajectory={result.trajectory}
          animFrame={animFrame}
          onClose={() => setGlobeViewOpen(false)}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, icon, className = "" }: { label: string, value: string, icon?: React.ReactNode, className?: string }) {
  return (
    <div className={`flex flex-col p-3 rounded-md bg-muted/20 border border-border/50 ${className}`}>
      <div className="flex items-center gap-1.5 mb-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-sm font-mono font-semibold tracking-tight text-foreground">{value}</span>
    </div>
  );
}
