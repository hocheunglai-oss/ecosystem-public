/* Local preview: source material transported once, plus broad pigment diffusion.
 * Source detail is reconstructed at unit gain, not sharpened or synthetically
 * replaced. The accepted calm flow and source anchoring remain 24s-periodic. */
(() => {
  const VERTEX = `#version 300 es
precision highp float; out vec2 uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
  const HEADER = `#version 300 es
precision highp float;
in vec2 uv; out vec4 colour;
uniform sampler2D sourceImage, field, materialField, lowReference;
uniform vec2 texel, sourceTexel, flowTexel, diffusionScale, cover;
uniform float time, dt;
vec4 sampleAt(sampler2D image,vec2 point){
 vec2 size=vec2(textureSize(image,0)),q=clamp(point*size-.5,vec2(0.),size-1.);
 ivec2 i=ivec2(floor(q)),j=min(i+1,ivec2(size)-1);vec2 f=fract(q);
 return mix(mix(texelFetch(image,i,0),texelFetch(image,ivec2(j.x,i.y),0),f.x),
            mix(texelFetch(image,ivec2(i.x,j.y),0),texelFetch(image,j,0),f.x),f.y);
}
float band(float y,float c,float s){float d=(y-c)/s;return exp(-d*d);}
vec2 flow(vec2 p){
 float ph=6.28318530718*time/24.;
 float front=band(p.y,.315,.17),lower=band(p.y,.16,.16),upper=band(p.y,.76,.18);
 float a=sin(6.2831853*p.x+ph+.6),b=sin(10.0*p.x-ph+1.7),c=cos(7.5*p.x+2.*ph+.3);
 float x=(2.8*tanh((p.y-.325)/.09)+1.5*sin(5.5*p.y+ph))*front;
 x+=2.1*cos(3.2*p.x+ph)*lower-.65*sin(4.4*p.x-ph)*upper;
 float y=(1.65*a+.7*b)*front+.45*c*lower+.50*b*upper+.75*sin(5.8*p.x-ph+.2)*band(p.y,.58,.21);
 float edge=smoothstep(.01,.16,p.x)*smoothstep(.01,.16,1.-p.x)*smoothstep(.012,.05,p.y)*smoothstep(.012,.05,1.-p.y);
 return 1.55*vec2(x,y)*edge*flowTexel;
}
float inside(vec2 p){return smoothstep(.015,.06,p.x)*smoothstep(.015,.06,1.-p.x)*smoothstep(.015,.045,p.y)*smoothstep(.015,.045,1.-p.y);}
float restoreRate(vec2 p){float edge=1.-inside(p);return .115+1.4*edge*edge;}
float cubicWeight(float x){x=abs(x);if(x<1.)return 1.5*x*x*x-2.5*x*x+1.;if(x<2.)return -.5*x*x*x+2.5*x*x-4.*x+2.;return 0.;}
// One source reconstruction per output frame. Bounded cubic interpolation
// avoids accumulating bilinear blur and never exceeds the four donor extrema.
vec3 sourceAt(vec2 point){
 ivec2 size=textureSize(sourceImage,0);vec2 q=clamp(point*vec2(size)-.5,vec2(0.),vec2(size)-1.);
 ivec2 base=ivec2(floor(q));vec2 f=fract(q);vec3 sum=vec3(0.),low=vec3(1.),high=vec3(0.);float weights=0.;
 for(int y=-1;y<=2;y++)for(int x=-1;x<=2;x++){
  ivec2 at=clamp(base+ivec2(x,y),ivec2(0),size-1);vec3 value=texelFetch(sourceImage,at,0).rgb;
  float weight=cubicWeight(float(x)-f.x)*cubicWeight(float(y)-f.y);sum+=value*weight;weights+=weight;
  if(x>=0&&x<=1&&y>=0&&y<=1){low=min(low,value);high=max(high,value);}
 }
 return clamp(sum/weights,low,high);
}
`;
  const FRAGMENTS = {
    blurHorizontal: `void main(){
 vec3 sum=vec3(0.);float weightSum=0.;
 for(int i=-8;i<=8;i++){float z=float(i)*.375,w=exp(-.5*z*z);sum+=texture(sourceImage,uv+vec2(z*20.*sourceTexel.x,0.)).rgb*w;weightSum+=w;}
 colour=vec4(sum/weightSum,1.);
}`,
    blurVertical: `void main(){
 vec3 sum=vec3(0.);float weightSum=0.;
 for(int i=-8;i<=8;i++){float z=float(i)*.375,w=exp(-.5*z*z);sum+=sampleAt(field,uv+vec2(0.,z*20.*sourceTexel.y)).rgb*w;weightSum+=w;}
 colour=vec4(sum/weightSum,1.);
}`,
    initMaterial: `void main(){colour=vec4(0.,0.,0.,1.);}`,
    initColour: `void main(){colour=sampleAt(lowReference,uv);}`,
    moveMaterial: `void main(){
 vec2 back=uv-flow(uv)*dt;
 // Store displacement rather than absolute coordinates. Zero displacement
 // reproduces the original even between a boundary and the first field texel.
 vec2 displacement=sampleAt(field,back).rg+(back-uv);
 displacement*=exp(-dt*restoreRate(uv));
 colour=vec4(displacement,0.,1.);
}`,
    moveColour: `void main(){
 vec2 back=uv-flow(uv)*dt;vec3 c=sampleAt(field,back).rgb;
 vec3 horizontal=sampleAt(field,back+vec2(texel.x,0.)).rgb+sampleAt(field,back-vec2(texel.x,0.)).rgb-2.*c;
 vec3 vertical=sampleAt(field,back+vec2(0.,texel.y)).rgb+sampleAt(field,back-vec2(0.,texel.y)).rgb-2.*c;
 float phase=6.28318530718*time/24.;float broad=.5+.5*sin(7.*uv.x+phase)*cos(4.*uv.y-phase);
 c+=dt*inside(uv)*((.28+.22*broad)*diffusionScale.x*horizontal+(.15+.12*broad)*diffusionScale.y*vertical);
 c=mix(c,sampleAt(lowReference,uv).rgb,1.-exp(-dt*restoreRate(uv)));
 colour=vec4(clamp(c,0.,1.),1.);
}`,
    display: `void main(){
 vec2 p=(uv-.5)*cover+.5;
 vec2 material=p+sampleAt(materialField,p).rg;
 vec3 exactSource=sourceAt(material);
 vec3 originalBroad=sampleAt(lowReference,material).rgb;
 vec3 movingBroad=sampleAt(field,p).rgb;
 // Matched decomposition/reconstruction at gain1: retain the original source
 // material coherently; replace only its broad colour with the evolved pigment.
 vec3 result=exactSource+(movingBroad-originalBroad);
 colour=vec4(clamp(result,0.,1.),1.);
}`,
  };

  window.createDiffuseStudy = async ({canvas,imageUrl,simulationWidth=640,materialWidth=384}) => {
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});
    if(!gl||!gl.getExtension('EXT_color_buffer_float'))throw Error('Floating point WebGL2 unavailable');
    const picture=new Image();picture.src=imageUrl;await picture.decode();
    if(!Number.isInteger(simulationWidth)||simulationWidth<256||simulationWidth>1600)throw Error('Colour width must be256–1600');
    if(!Number.isInteger(materialWidth)||materialWidth<128||materialWidth>1600)throw Error('Material width must be128–1600');
    const w=simulationWidth,h=Math.round(w*picture.height/picture.width);
    const mw=materialWidth,mh=Math.round(mw*picture.height/picture.width);
    const baseHeight=1200*picture.height/picture.width;
    const programs={},shaders=[],buffers=[];let seconds=0,steps=0,destroyed=false;
    function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));shaders.push(s);return s;}
    const vertex=shader(gl.VERTEX_SHADER,VERTEX);
    for(const[name,fragment]of Object.entries(FRAGMENTS)){
      const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,shader(gl.FRAGMENT_SHADER,HEADER+fragment));gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));programs[name]={program,uniforms:new Map()};
    }
    function makeField(width,height){
      const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width,height,0,gl.RGBA,gl.FLOAT,null);
      const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Incomplete image field');
      const result={texture,framebuffer,width,height};buffers.push(result);return result;
    }
    let read=makeField(w,h),write=makeField(w,h),materialRead=makeField(mw,mh),materialWrite=makeField(mw,mh);
    const blurTemporary=makeField(w,h),reference=makeField(w,h);
    const source=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,source);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,picture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    const vao=gl.createVertexArray();gl.bindVertexArray(vao);
    function draw(name,target,values={}){
      const shader=programs[name];gl.useProgram(shader.program);gl.bindFramebuffer(gl.FRAMEBUFFER,target?.framebuffer||null);gl.viewport(0,0,target?.width||canvas.width,target?.height||canvas.height);let unit=0;
      for(const[key,value]of Object.entries({sourceImage:source,field:read.texture,materialField:materialRead.texture,lowReference:reference.texture,texel:[1/w,1/h],sourceTexel:[1/picture.width,1/picture.height],flowTexel:[1/1200,1/baseHeight],diffusionScale:[(w/1200)**2,(h/baseHeight)**2],time:seconds%24,...values})){
        if(!shader.uniforms.has(key))shader.uniforms.set(key,gl.getUniformLocation(shader.program,key));const location=shader.uniforms.get(key);if(location===null)continue;
        if(value instanceof WebGLTexture){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,value);gl.uniform1i(location,unit++);}else if(Array.isArray(value))gl.uniform2f(location,...value);else gl.uniform1f(location,value);
      }
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    draw('blurHorizontal',blurTemporary);draw('blurVertical',reference,{field:blurTemporary.texture});
    function reset(){if(destroyed)throw Error('Renderer destroyed');seconds=0;steps=0;draw('initColour',read);draw('initMaterial',materialRead);}
    function oneStep(dt){const time=(seconds+.5*dt)%24;draw('moveMaterial',materialWrite,{field:materialRead.texture,dt,time});draw('moveColour',write,{dt,time});[read,write]=[write,read];[materialRead,materialWrite]=[materialWrite,materialRead];seconds+=dt;steps++;}
    function step(dt){if(destroyed||!Number.isFinite(dt)||dt<0||dt>1)throw Error('Invalid animation step');while(dt>1e-8){const amount=Math.min(dt,1/30);oneStep(amount);dt-=amount;}}
    function render(){if(destroyed)return;const aspect=canvas.width/canvas.height,original=picture.width/picture.height;draw('display',null,{cover:[Math.min(1,aspect/original),Math.min(1,original/aspect)]});}
    function advanceTo(target){if(destroyed||!Number.isFinite(target)||target<0)throw Error('Invalid animation time');if(target<seconds-1e-7)reset();while(target-seconds>1e-8)oneStep(Math.min(1/30,target-seconds));render();}
    function measure(target,channels){gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);const data=new Float32Array(target.width*target.height*4);gl.readPixels(0,0,target.width,target.height,gl.RGBA,gl.FLOAT,data);let min=1,max=0,finite=true;for(let i=0;i<data.length;i+=4)for(let c=0;c<channels;c++){const value=data[i+c];min=Math.min(min,value);max=Math.max(max,value);finite&&=Number.isFinite(value);}return{min,max,finite};}
    function diagnostics(){if(destroyed)throw Error('Renderer destroyed');const pigment=measure(read,3),material=measure(materialRead,2),glError=gl.getError();render();return{seconds,steps,simulation:[w,h],materialSimulation:[mw,mh],sourceDimensions:[picture.width,picture.height],finite:pigment.finite&&material.finite,range:[pigment.min,pigment.max],materialRange:[material.min,material.max],glError,method:'transported original material plus broad RGB advection-diffusion; matched source reconstruction at unit gain',periodSeconds:24,sourceRestoreRate:.115,lowReferenceSigmaSourcePixels:20,sourceInterpolation:'bounded cubic, sampled once at output',artificialGrain:false,detailGain:1,fieldTextureBytes:buffers.reduce((sum,item)=>sum+item.width*item.height*16,0),paidVideoServices:false};}
    function destroy(){if(destroyed)return;destroyed=true;for(const buffer of buffers){gl.deleteTexture(buffer.texture);gl.deleteFramebuffer(buffer.framebuffer);}for(const shader of Object.values(programs))gl.deleteProgram(shader.program);for(const shader of shaders)gl.deleteShader(shader);gl.deleteTexture(source);gl.deleteVertexArray(vao);}
    reset();render();return{step,render,advanceTo,reset,diagnostics,destroy};
  };
})();
