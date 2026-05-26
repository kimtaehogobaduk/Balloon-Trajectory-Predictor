import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format, addHours } from "date-fns";
import { Map as MapIcon, Crosshair, Wind, Navigation, Activity, Clock, Layers, Rocket, Settings2, Play, Pause, Video } from "lucide-react";
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts";

import { useRunSimulation, useGetPresets, getGetPresetsQueryKey } from "@workspace/api-client-react";
import type { SimulationInput, SimulationResult } from "@workspace/api-client-react";

import { BalloonMap } from "@/components/Map";
import BalloonCamera from "@/components/BalloonCamera";
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

const formSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  launch_datetime: z.string().min(1, "Launch datetime is required"),
  balloon_mass_g: z.coerce.number().min(50).max(3000),
  payload_mass_g: z.coerce.number().min(0).max(10000),
  ascent_rate: z.coerce.number().min(0.5).max(20),
  descent_rate: z.coerce.number().min(1).max(30),
  time_step: z.coerce.number().min(1).max(300).default(60),
});

export default function Home() {
  const [result, setResult] = useState<SimulationResult | null>(null);
  
  // Animation State
  const [animFrame, setAnimFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [videoViewOpen, setVideoViewOpen] = useState(false);

  const { data: presets } = useGetPresets({
    query: { queryKey: getGetPresetsQueryKey() }
  });

  const runSim = useRunSimulation();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      latitude: 37.5665,
      longitude: 126.9780,
      launch_datetime: format(addHours(new Date(), 1), "yyyy-MM-dd'T'HH:mm"),
      balloon_mass_g: 1000,
      payload_mass_g: 500,
      ascent_rate: 5.0,
      descent_rate: 6.0,
      time_step: 60,
    },
  });

  const handleRunSimulation = (values: z.infer<typeof formSchema>) => {
    const date = new Date(values.launch_datetime);
    
    runSim.mutate(
      {
        data: {
          ...values,
          launch_datetime: date.toISOString(),
        }
      },
      {
        onSuccess: (data) => {
          setResult(data);
          setAnimFrame(0);
          setIsPlaying(false);
        }
      }
    );
  };

  const loadPreset = (presetId: string) => {
    const preset = presets?.find(p => p.id === presetId);
    if (preset) {
      form.reset({
        ...preset.config,
        launch_datetime: format(new Date(preset.config.launch_datetime), "yyyy-MM-dd'T'HH:mm")
      });
    }
  };

  const currentLat = form.watch("latitude");
  const currentLng = form.watch("longitude");

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

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-sans selection:bg-primary/30">
      
      {/* Left Sidebar */}
      <div className="w-[480px] min-w-[480px] h-full flex flex-col border-r border-border bg-card/50 backdrop-blur shadow-2xl relative z-10">
        
        <div className="px-6 py-5 border-b border-border bg-card">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50 text-primary">
              <Rocket className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight uppercase text-foreground">Fall Prediction Simulator</h1>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">Flight Planning Tool v1.0</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-8">
            
            {/* Form Section */}
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

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="ascent_rate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">ASCENT (m/s)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="descent_rate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">DESCENT (m/s)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>

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

                  {/* Live Telemetry Panel */}
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
        </ScrollArea>
      </div>

      {/* Right Side - Interactive Map */}
      <div className="flex-1 relative bg-black">
        <BalloonMap 
          simulationResult={result} 
          launchPos={{ lat: currentLat || 37.5665, lng: currentLng || 126.9780 }} 
          animFrame={result ? animFrame : undefined}
        />
        
        {/* Map Header Overlay */}
        <div className="absolute top-4 right-4 z-[400] flex gap-2">
          {result && (
            <Button 
              variant="secondary" 
              className="bg-background/90 backdrop-blur shadow-lg border-border font-mono font-bold text-xs flex items-center gap-2"
              onClick={() => setVideoViewOpen(true)}
            >
              <Video className="w-4 h-4" />
              VIDEO VIEW
            </Button>
          )}
        </div>

        {/* Map UI overlays */}
        <div className="absolute bottom-6 right-6 z-[400] flex gap-2">
          {result && (
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
        </div>
      </div>

      {videoViewOpen && result && (
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
